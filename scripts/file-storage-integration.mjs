import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { LocalInvoiceFiles, PostgresInvoiceFiles } from '../app/adapters/files.ts';
import { PostgresRepository } from '../app/adapters/postgres.ts';
import { config } from '../app/config.ts';

const sourceUrl = new URL(process.env.DATABASE_URL);
const databaseName = `efactura_files_${randomBytes(6).toString('hex')}`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
const directory = await mkdtemp(join(tmpdir(), 'efactura-files-'));
const admin = new pg.Client({ connectionString: sourceUrl.toString() });
await admin.connect();
let repo;
try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const cfg = config({ ...process.env, DATABASE_URL: testUrl.toString(), APP_DATABASE_NAME: databaseName,
        DATA_DIR: directory,
        ANAF_MODE: 'mock', ANAF_CIF: '12345678' });
    repo = new PostgresRepository(cfg);
    await repo.initialize();
    const first = await repo.company();
    const second = await repo.createCompany({ name: 'Second', kind: 'company', cif: '87654321',
        emailTo: 'second@example.org', emailEnabled: false, pollSeconds: 60 });
    const invoice = { number: 'TEST-1', issueDate: '2026-09-25', dueDate: '', supplier: 'Test supplier',
        supplierCif: '1234', currency: 'RON', net: '10.00', tax: '0.00', total: '10.00', lines: [] };
    await repo.insertInvoice('900001', invoice, false);
    await repo.pdfReady((await repo.invoices())[0].id);
    await repo.forCompany(second.id).insertInvoice('900001', invoice, false);
    const firstLegacy = new LocalInvoiceFiles(cfg);
    const secondLegacy = new LocalInvoiceFiles({ ...cfg, cif: second.cif });
    const firstZip = Buffer.from('PK-original-first');
    const secondZip = Buffer.from('PK-original-second');
    const pdf = Buffer.from('%PDF-original');
    await firstLegacy.put('900001', 'zip', firstZip);
    await secondLegacy.put('900001', 'zip', secondZip);
    const readLegacy = ({ cif }, messageId, kind) => new LocalInvoiceFiles({ ...cfg, cif }).read(messageId, kind);
    await assert.rejects(repo.migrateLegacyFiles(readLegacy), { code: 'ENOENT' });
    await firstLegacy.put('900001', 'pdf', pdf);
    await repo.migrateLegacyFiles(readLegacy);
    const firstFiles = new PostgresInvoiceFiles(repo);
    const secondFiles = new PostgresInvoiceFiles(repo.forCompany(second.id));
    assert.deepEqual(await firstFiles.read('900001', 'zip'), firstZip);
    assert.deepEqual(await firstFiles.read('900001', 'pdf'), pdf);
    assert.deepEqual(await secondFiles.read('900001', 'zip'), secondZip);
    await firstFiles.put('900001', 'zip', firstZip);
    await assert.rejects(firstFiles.put('900001', 'zip', Buffer.from('PK-changed')),
        /original invoice ZIP differs/);
    await firstFiles.put('900001', 'pdf', Buffer.from('%PDF-regenerated'));
    assert.deepEqual(await firstFiles.read('900001', 'pdf'), pdf,
        'A PDF retry keeps the first successfully stored document');
    const client = new pg.Client({ connectionString: testUrl.toString() });
    await client.connect();
    try {
        const { rows: [counts] } = await client.query(`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE kind='zip')::int AS zips,
            count(*) FILTER (WHERE kind='pdf')::int AS pdfs FROM invoice_files`);
        assert.deepEqual(counts, { total: 3, zips: 2, pdfs: 1 });
    } finally { await client.end(); }
    await repo.migrateLegacyFiles(async () => { assert.fail('Completed migration must not read legacy files again.'); });
    const repair = new pg.Client({ connectionString: testUrl.toString() });
    await repair.connect();
    try {
        await repair.query(`DELETE FROM invoice_files WHERE company_id=$1 AND message_id='900001' AND kind='pdf'`, [first.id]);
    } finally { await repair.end(); }
    await repo.migrateLegacyFiles(readLegacy);
    assert.deepEqual(await firstFiles.read('900001', 'pdf'), pdf,
        'A later startup restores a document missing after the first migration');
    console.log('PASS: interrupted migration resumes, ZIP/PDF bytes persist in PostgreSQL, and companies remain isolated.');
} finally {
    if (repo) await repo.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
}
