import assert from 'node:assert/strict';
import pg from 'pg';
import { config } from '../dist/server/app/config.js';
import { PostgresRepository } from '../dist/server/app/adapters/postgres.js';

const cfg = config({ ANAF_MODE: 'mock', ANAF_CIF: '9999999998765' });
const repo = new PostgresRepository(cfg);
const other = new PostgresRepository(cfg);
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
let company;
try {
    await repo.initialize();
    company = await repo.company();
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
    if (company) {
        await pool.query('DELETE FROM outbox WHERE company_id=$1', [company.id]);
        await pool.query('DELETE FROM invoices WHERE company_id=$1', [company.id]);
        await pool.query('DELETE FROM companies WHERE id=$1', [company.id]);
    }
    await Promise.all([repo.close(), other.close(), pool.end()]);
}
