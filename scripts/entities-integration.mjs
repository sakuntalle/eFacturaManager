import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runtime } from '../app/runtime.ts';

const sourceUrl = new URL(process.env.DATABASE_URL);
const databaseName = `efactura_entities_${randomBytes(6).toString('hex')}`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: sourceUrl.toString() });
await admin.connect();
let app;
try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    process.env.DATABASE_URL = testUrl.toString();
    process.env.ANAF_MODE = 'mock';
    process.env.ANAF_CIF = '12345678';
    app = await runtime();
    const first = await app.repo.company();
    const second = await app.repo.createCompany({ name: 'Another company', kind: 'company', cif: '87654321',
        emailTo: 'other@example.org', emailEnabled: false, pollSeconds: 90 });
    const person = await app.repo.createCompany({ name: 'Individual', kind: 'individual', cif: '1234567890123',
        emailTo: 'person@example.org', emailEnabled: true, pollSeconds: 120 });
    assert.equal((await app.repo.companies()).length, 3);
    assert.equal((await app.scope(second.id)).cfg.smtp.to, 'other@example.org');
    assert.equal((await app.scope(person.id)).cfg.cif, '1234567890123');
    const firstRepo = app.repo.forCompany(first.id);
    const secondRepo = app.repo.forCompany(second.id);
    const invoice = { number: 'TEST-1', issueDate: '2026-01-01', dueDate: '2026-01-01', supplier: 'Test supplier',
        supplierCif: '99999999', currency: 'RON', net: '10.00', tax: '0.00', total: '10.00', lines: [] };
    await firstRepo.insertInvoice('10001', invoice, true, '2026-09-25');
    await secondRepo.insertInvoice('10001', invoice, true);
    assert.equal((await firstRepo.invoices()).length, 1);
    assert.equal((await secondRepo.invoices()).length, 1);
    assert.notEqual((await firstRepo.invoices())[0].id, (await secondRepo.invoices())[0].id);
    assert.equal((await firstRepo.invoices())[0].addedDate, '2026-09-25');
    assert.equal((await secondRepo.invoices())[0].addedDate, null);
    assert.equal(await secondRepo.addedDateBackfillPending(), true);
    await secondRepo.updateInvoiceAddedDate('10001', '2026-09-24');
    assert.equal((await secondRepo.invoices())[0].addedDate, '2026-09-24');
    await secondRepo.updateInvoiceAddedDate('10001', '2026-09-24T15:45');
    assert.equal((await secondRepo.invoices())[0].addedDate, '2026-09-24T15:45');
    assert.equal((await firstRepo.invoices())[0].addedDate, '2026-09-25');
    await secondRepo.markAddedDateBackfilled();
    assert.equal(await secondRepo.addedDateBackfillPending(), false);
    assert.equal(await firstRepo.addedDateBackfillPending(), true);
    assert.equal((await app.repo.forCompany(person.id).invoices()).length, 0);
    const personRepo = app.repo.forCompany(person.id);
    for (const [messageId, number, issueDate, addedDate] of [
        ['20001', 'AUG-FIRST', '2026-08-06', '2026-09-03T09:30'],
        ['20002', 'SEP-NEWEST', '2026-09-01', '2026-09-01T09:00'],
        ['20003', 'AUG-SECOND', '2026-08-06', null],
        ['20004', 'AUG-LATER', '2026-08-05', '2026-09-03T10:30'],
    ]) {
        await personRepo.insertInvoice(messageId, { ...invoice, number, issueDate }, false, addedDate);
    }
    assert.deepEqual((await personRepo.invoices()).map(item => item.number),
        ['AUG-LATER', 'AUG-FIRST', 'SEP-NEWEST', 'AUG-SECOND'],
        'Invoice inbox defaults to newest Added date and time, with missing dates last');
    assert.deepEqual((await personRepo.invoices('', 'issue', 'desc')).map(item => item.number),
        ['SEP-NEWEST', 'AUG-FIRST', 'AUG-SECOND', 'AUG-LATER']);
    assert.deepEqual((await personRepo.invoices('', 'issue', 'asc')).map(item => item.number),
        ['AUG-LATER', 'AUG-FIRST', 'AUG-SECOND', 'SEP-NEWEST']);
    assert.deepEqual((await personRepo.invoices('', 'added', 'asc')).map(item => item.number),
        ['SEP-NEWEST', 'AUG-FIRST', 'AUG-LATER', 'AUG-SECOND']);
    for (let index = 0; index < 201; index++) {
        await personRepo.insertInvoice(String(30000 + index), {
            ...invoice, number: `PAGED-${index}`, supplier: index === 0 ? 'Needle supplier' : 'Other supplier',
        }, false, '2026-09-04T12:00');
    }
    const pages = [];
    for (let page = 1; page <= 5; page++) pages.push(await personRepo.invoicePage('', 'added', 'desc', page, 50));
    assert.deepEqual(pages.map(result => result.items.length), [50, 50, 50, 50, 5]);
    assert.ok(pages.every(result => result.total === 205 && result.allTotal === 205));
    assert.equal(new Set(pages.flatMap(result => result.items.map(item => item.id))).size, 205,
        'Pagination must expose every invoice exactly once, including those beyond the former 200 limit');
    const searchPage = await personRepo.invoicePage('Needle', 'added', 'desc', 1, 50);
    assert.equal(searchPage.total, 1);
    assert.equal(searchPage.allTotal, 205);
    assert.equal(searchPage.items[0].number, 'PAGED-0');
    assert.deepEqual((await firstRepo.invoicePage('', 'added', 'desc', 1, 50)).items.map(item => item.number), ['TEST-1']);
    assert.equal((await firstRepo.events()).length, 2);
    assert.equal((await secondRepo.events()).length, 2);
    await secondRepo.updateCompany({ name: 'Renamed company', kind: 'company', cif: second.cif,
        emailTo: 'new@example.org', emailEnabled: true, pollSeconds: 180 });
    assert.equal((await firstRepo.company()).pollSeconds, first.pollSeconds);
    assert.equal((await secondRepo.company()).pollSeconds, 180);
    assert.equal((await app.scope(second.id)).cfg.smtp.to, 'new@example.org');
    assert.equal((await app.connection.status()).state, 'mock');
    const db = new pg.Client({ connectionString: testUrl.toString() });
    await db.connect();
    try {
        const connection = { state: 'disconnected', encrypted: null, fingerprint: '', connectedAt: null };
        await db.query(`CREATE TABLE anaf_connections (
            company_id uuid PRIMARY KEY REFERENCES companies(id), data jsonb NOT NULL, attempt jsonb)`);
        await db.query('INSERT INTO anaf_connections(company_id,data) VALUES ($1,$2)', [first.id, connection]);
        await app.repo.initialize();
        assert.deepEqual(await app.repo.connection(), connection, 'Legacy ANAF connection moves to workspace storage');
        await app.scope(second.id).then(item => item.files.put('10001', 'zip', Buffer.from('test invoice archive')));
        assert.equal((await db.query('SELECT count(*)::integer AS count FROM invoice_files WHERE company_id=$1', [second.id])).rows[0].count, 1);
        assert.deepEqual(await app.repo.deleteCompany(second.id), { deleted: true, nextCompanyId: first.id });
        assert.equal((await db.query('SELECT count(*)::integer AS count FROM invoices WHERE company_id=$1', [second.id])).rows[0].count, 0);
        assert.equal((await db.query('SELECT count(*)::integer AS count FROM invoice_files WHERE company_id=$1', [second.id])).rows[0].count, 0);
        assert.equal((await db.query('SELECT count(*)::integer AS count FROM outbox WHERE company_id=$1', [second.id])).rows[0].count, 0);
        assert.equal(await app.repo.findCompany(second.id), null);
        await assert.rejects(app.scope(second.id), /Company not found/);
        await app.repo.deleteCompany(first.id);
        assert.equal((await app.repo.company()).id, person.id, 'Deleting the original entity selects a remaining entity');
        assert.deepEqual(await app.repo.connection(), connection, 'Shared ANAF connection survives deleting its original entity');
        assert.deepEqual(await app.repo.deleteCompany(person.id), { deleted: true, nextCompanyId: null });
        assert.equal((await app.repo.companies()).length, 0);
        await app.repo.initialize();
        assert.equal((await app.repo.companies()).length, 0, 'Deleted entities must not reappear on restart');
    } finally { await db.end(); }
    console.log('PASS: three entities retain isolated invoices, jobs, settings and notification recipients.');
} finally {
    if (app) { await app.queue.close(); await app.repo.close(); }
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
}
