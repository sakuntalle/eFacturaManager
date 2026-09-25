import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import type { InvoiceData } from './contracts.js';

export function invoiceXml(archive: Uint8Array): Uint8Array {
    let total = 0;
    let count = 0;
    const files = unzipSync(archive, { filter: file => {
        total += file.originalSize;
        if (++count > 20 || total > 10 * 1024 * 1024) throw new Error('Archive exceeds XML extraction limits.');
        return file.name.toLowerCase().endsWith('.xml');
    } });
    const candidates = Object.values(files).filter(bytes => /<(?:[\w-]+:)?(?:Invoice|CreditNote)[\s>]/.test(Buffer.from(bytes).toString('utf8')));
    if (candidates.length !== 1) throw new Error('Expected exactly one invoice XML in the archive.');
    return candidates[0];
}

export function parseInvoice(bytes: Uint8Array): InvoiceData {
    const xml = Buffer.from(bytes).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid or unsupported invoice XML.');
    const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
        parseTagValue: false, parseAttributeValue: false, processEntities: true }).parse(xml);
    const root = parsed.Invoice ?? parsed.CreditNote;
    if (!root) throw new Error('Unsupported invoice XML root.');
    const text = (value: unknown): string => typeof value === 'string' ? value
        : value && typeof value === 'object' && '#text' in value ? String(value['#text']) : '';
    const money = (value: unknown): string => {
        const result = text(value);
        if (!/^-?\d+(?:\.\d{1,8})?$/.test(result)) throw new Error('Invoice contains an unsupported decimal amount.');
        return result;
    };
    const supplier = root.AccountingSupplierParty?.Party;
    const totals = root.LegalMonetaryTotal;
    const lineValues = root.InvoiceLine ?? root.CreditNoteLine ?? [];
    const lines = (Array.isArray(lineValues) ? lineValues : [lineValues]).map(line => ({
        description: text(line.Item?.Name), quantity: text(line.InvoicedQuantity ?? line.CreditedQuantity),
        amount: money(line.LineExtensionAmount),
    }));
    const taxes = Array.isArray(root.TaxTotal) ? root.TaxTotal[0] : root.TaxTotal;
    const data = {
        number: text(root.ID), issueDate: text(root.IssueDate), dueDate: text(root.DueDate),
        supplier: text(supplier?.PartyLegalEntity?.RegistrationName ?? supplier?.PartyName?.Name),
        supplierCif: text(supplier?.PartyTaxScheme?.CompanyID), currency: text(root.DocumentCurrencyCode),
        net: money(totals?.TaxExclusiveAmount), tax: money(taxes?.TaxAmount), total: money(totals?.TaxInclusiveAmount),
        totalBasis: 'tax-inclusive' as const, lines,
    };
    if (!data.number || !data.supplier || !/^[A-Z]{3}$/.test(data.currency)) throw new Error('Missing required invoice details.');
    return data;
}
