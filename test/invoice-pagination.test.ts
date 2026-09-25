import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { config } from '../app/config.js';
import { PostgresRepository } from '../app/adapters/postgres.js';

test('205 invoices remain reachable across all pages, including beyond the former 200-item limit', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({
        id: `invoice-${index}`, message_id: String(index), created_at: new Date('2026-09-25T12:00:00Z'),
        added_date: new Date(Date.UTC(2026, 8, 25, 12, index)).toISOString(), pdf_ready: true,
        data: { number: `TEST-${index}`, supplier: index === 204 ? 'Needle supplier' : 'Other supplier',
            issueDate: '2026-09-25', dueDate: '2026-09-25', supplierCif: '12345678', currency: 'RON',
            net: '10.00', tax: '0.00', total: '10.00', lines: [] },
    })).reverse();
    const requestedOffsets: number[] = [];
    const pool = { query: async (sql: string, params: unknown[]) => {
        assert.equal(params[0], '00000000-0000-4000-8000-000000000001');
        const search = String(params[1]).slice(1, -1).toLowerCase();
        const matching = rows.filter(row => `${row.data.supplier} ${row.data.number}`.toLowerCase().includes(search));
        if (sql.includes('count(*)')) return { rows: [{ total: matching.length, all_total: rows.length }] };
        assert.match(sql, /LIMIT \$3 OFFSET \$4/);
        assert.equal(params[2], 50);
        const offset = Number(params[3]);
        requestedOffsets.push(offset);
        return { rows: matching.slice(offset, offset + 50) };
    } } as unknown as pg.Pool;
    const repo = new PostgresRepository(config({ ANAF_MODE: 'mock' }),
        '00000000-0000-4000-8000-000000000001', pool);
    const pages = [];
    for (let page = 1; page <= 5; page++) pages.push(await repo.invoicePage('', 'added', 'desc', page, 50));
    assert.deepEqual(requestedOffsets, [0, 50, 100, 150, 200]);
    assert.deepEqual(pages.map(page => page.items.length), [50, 50, 50, 50, 5]);
    assert.ok(pages.every(page => page.total === 205 && page.allTotal === 205));
    assert.equal(new Set(pages.flatMap(page => page.items.map(invoice => invoice.id))).size, 205);
    assert.equal(pages[4].items.at(-1)?.number, 'TEST-0');
    const searched = await repo.invoicePage('Needle', 'added', 'desc', 1, 50);
    assert.equal(searched.total, 1);
    assert.equal(searched.allTotal, 205);
    assert.equal(searched.items[0].number, 'TEST-204');
});
