export type MockInvoiceInput = { supplierName: string; amountRon: string };

export function mockInvoiceInput(value: { supplierName?: unknown; amountRon?: unknown }): MockInvoiceInput {
    if (typeof value.supplierName !== 'string') throw new Error('Enter a supplier name.');
    const supplierName = value.supplierName.trim();
    if (!supplierName || supplierName.length > 200 || /[\u0000-\u001f\u007f]/u.test(supplierName)) {
        throw new Error('Supplier name must be 1–200 characters without control characters.');
    }
    if (typeof value.amountRon !== 'string' || !/^\d{1,9}(?:[.,]\d{1,2})?$/.test(value.amountRon.trim())) {
        throw new Error('Enter a positive RON amount with at most two decimal places (maximum 999999999.99).');
    }
    const [whole, fraction = ''] = value.amountRon.trim().replace(',', '.').split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (cents <= 0n) throw new Error('Amount must be greater than zero.');
    return { supplierName, amountRon: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` };
}
