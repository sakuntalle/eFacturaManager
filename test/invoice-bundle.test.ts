import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import type { Invoice } from '../app/contracts.js';
import { bulkInvoiceIds, createInvoiceBundle } from '../app/invoice-bundle.js';

function invoice(messageId: string): Invoice {
    return { id: `00000000-0000-4000-8000-${messageId.padStart(12, '0')}`, messageId,
        number: `TEST-${messageId}`, supplier: 'Test supplier', supplierCif: '1234', issueDate: '2026-10-01',
        dueDate: '', currency: 'RON', net: '10.00', tax: '0.00', total: '10.00', lines: [],
        createdAt: '2026-10-01T10:00:00Z', addedDate: '2026-10-01T10:00:00Z', pdfReady: true };
}

test('bulk invoice archive contains one predictably named document per selected invoice', async () => {
    const reads: string[] = [];
    const bundle = await createInvoiceBundle([invoice('101'), invoice('202')], 'pdf', async (messageId, kind) => {
        reads.push(`${messageId}.${kind}`);
        return Buffer.from(`document-${messageId}`);
    });
    const files = unzipSync(bundle);
    assert.deepEqual(reads, ['101.pdf', '202.pdf']);
    assert.deepEqual(Object.keys(files), ['invoice-101.pdf', 'invoice-202.pdf']);
    assert.equal(Buffer.from(files['invoice-101.pdf']!).toString(), 'document-101');
    assert.equal(Buffer.from(files['invoice-202.pdf']!).toString(), 'document-202');
});

test('bulk invoice selection is not capped at one page', () => {
    const ids = Array.from({ length: 125 }, (_, index) => `invoice-${index}`);
    assert.deepEqual(bulkInvoiceIds(ids), ids);
    assert.throws(() => bulkInvoiceIds([]), /at least one/);
    assert.throws(() => bulkInvoiceIds([ids[0], ids[0]]), /unique/);
});
