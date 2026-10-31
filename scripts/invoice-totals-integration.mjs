import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { config } from '../dist/server/app/config.js';
import { PostgresRepository } from '../dist/server/app/adapters/postgres.js';

const source = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('Invoice integration requires local PostgreSQL.');
const name = `efactura_totals_${randomBytes(6).toString('hex')}`;
const target = new URL(source);
target.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: source.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const cfg = config({ ...process.env, DATABASE_URL: target.toString(), APP_DATABASE_NAME: name,
    ANAF_MODE: 'live', ANAF_ENV: 'prod', DATA_DIR: '.local/test', APP_PUBLIC_URL: 'https://localhost:8765' });
const root = new PostgresRepository(cfg);
let repo = root;
let other;
let company;
try {
    await repo.initialize();
    const connection = await repo.createManagedConnection('Invoice totals regression');
    company = await repo.createCompany({ name: 'Invoice totals test', kind: 'company', cif: '9999999998765',
        emailTo: 'test@example.org', emailEnabled: false, pollSeconds: 60 }, connection.id);
    repo = root.forCompany(company.id);
    other = root.forCompany(company.id);
    for (const message of ['87651', '87652']) {
        await repo.insertInvoice(message, { number: message, issueDate: '2026-09-25', dueDate: '', supplier: 'Synthetic migration fixture',
            supplierCif: '1234', currency: 'RON', net: '30.25', tax: '0.00', total: '0.00', lines: [] }, false);
    }
    const before = await repo.invoices();
    await repo.pdfReady(before[0].id);
    const events = await repo.events();
    let reads = 0;
    await assert.rejects(repo.migrateInvoiceTotals(async () => {
        if (++reads === 2) throw new Error('Synthetic missing XML');
        return '30.25';
    }), /Synthetic missing XML/);
    assert.ok((await repo.invoices()).every(i => i.total === '0.00' && !i.totalBasis), 'A failed migration must roll back all updates');
    reads = 0;
    const readTotal = async () => { reads++; return '30.25'; };
    await Promise.all([repo.migrateInvoiceTotals(readTotal), other.migrateInvoiceTotals(readTotal)]);
    assert.equal(reads, 2, 'Concurrent migrations must process each invoice once');
    const after = await repo.invoices();
    assert.ok(after.every(i => i.total === '30.25' && i.totalBasis === 'tax-inclusive'));
    assert.equal(after.find(i => i.id === before[0].id).pdfReady, true);
    assert.deepEqual(after.map(i => i.id), before.map(i => i.id));
    assert.deepEqual(await repo.events(), events, 'Migration must not enqueue or resend notifications');
    await repo.migrateInvoiceTotals(async () => { assert.fail('Migration must be idempotent'); });
    console.log('PASS: stored invoice amount correction, transactional rollback, concurrent startup, idempotency, preserved PDF status and unchanged notifications.');
} finally {
    await root.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
}
