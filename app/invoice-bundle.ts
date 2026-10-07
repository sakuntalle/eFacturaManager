import { zipSync } from 'fflate';
import type { Invoice } from './contracts.js';

export type InvoiceDocumentKind = 'zip' | 'pdf';

export function bulkInvoiceIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.some(id => typeof id !== 'string')) {
        throw new Error('Select at least one invoice.');
    }
    if (new Set(value).size !== value.length) throw new Error('Each selected invoice must be unique.');
    return value as string[];
}

export async function createInvoiceBundle(invoices: Invoice[], kind: InvoiceDocumentKind,
    read: (messageId: string, kind: InvoiceDocumentKind) => Promise<Buffer>): Promise<Uint8Array> {
    const documents = await Promise.all(invoices.map(async invoice => [
        `invoice-${invoice.messageId}.${kind}`,
        await read(invoice.messageId, kind),
    ] as const));
    return zipSync(Object.fromEntries(documents), { level: 0 });
}
