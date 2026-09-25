import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { config } from '../app/config.js';
import { sampleXml, samplePdf } from '../app/mock/fixtures.js';
import { mockInvoiceInput } from '../app/mock/invoice-input.js';
import { invoiceXml, parseInvoice } from '../app/invoice-xml.js';
import { Workflows } from '../app/workflows.js';
import type { Event, Invoice, Repository, JobQueue, InvoiceFiles, AnafGateway, NotificationChannel } from '../app/contracts.js';

test('ANAF mode and SMTP are independent, and deployment OAuth credentials never enter mock configuration', () => {
    const cfg = config({ ANAF_MODE: 'mock', ANAF_CLIENT_ID: 'live-id', ANAF_CLIENT_SECRET: 'live-secret', SMTP_HOST: 'smtp.example.com', EMAIL_ENABLED: 'true' });
    assert.equal(cfg.oauth.clientId, '');
    assert.equal(cfg.oauth.clientSecret, '');
    assert.equal(cfg.emailEnabled, true);
    assert.equal(cfg.smtp.host, 'smtp.example.com');
    assert.equal(config({ ANAF_MODE: 'live', ANAF_CIF: '1234', EMAIL_ENABLED: 'false' }).emailEnabled, false);
    assert.throws(() => config({ ANAF_MODE: 'typo' }));
    assert.throws(() => config({ ANAF_MOCK_URL: 'https://outside.example' }));
});

test('archive parser preserves exact decimal strings, selects invoice XML and rejects entity declarations', async () => {
    const xml = sampleXml(1, '12345678', '2026-09-25');
    const archive = zipSync({ 'invoice.xml': strToU8(xml), 'signature.xml': strToU8('<MockSignature>FAKE</MockSignature>') });
    const data = parseInvoice(invoiceXml(archive));
    assert.equal(data.total, '145.20');
    assert.equal(data.net, '120.00');
    assert.equal(data.supplier, 'Demo Office Supplies SRL');
    assert.throws(() => parseInvoice(strToU8('<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>&x;</Invoice>')));
    assert.throws(() => invoiceXml(zipSync({ 'one.xml': strToU8(xml), 'two.xml': strToU8(xml) })));
    assert.equal((await samplePdf(strToU8(xml))).subarray(0, 5).toString(), '%PDF-');
});

test('custom simulated invoices preserve supplier text and exact RON amounts through XML', () => {
    const supplierName = 'Ștefan & Partners <SRL> "Office"';
    const input = mockInvoiceInput({ supplierName: ` ${supplierName} `, amountRon: '000987,65' });
    assert.deepEqual(input, { supplierName, amountRon: '987.65' });
    const invoice = parseInvoice(strToU8(sampleXml(42, '12345678', '2026-09-25', input)));
    assert.equal(invoice.supplier, supplierName);
    assert.equal(invoice.number, 'DEMO-0042');
    assert.equal(invoice.currency, 'RON');
    assert.equal(invoice.total, '987.65');
    assert.equal(invoice.net, '987.65');
    assert.equal(invoice.tax, '0.00');
    assert.equal(invoice.lines[0].amount, '987.65');
    for (const [amountRon, expected] of [['1', '1.00'], ['1.2', '1.20'], ['0,01', '0.01'], ['999999999.99', '999999999.99']]) {
        assert.equal(mockInvoiceInput({ supplierName, amountRon }).amountRon, expected);
    }
});

test('simulator rejects invalid suppliers and amounts before creating an invoice', () => {
    for (const supplierName of [undefined, 123, '', '  ', 'a'.repeat(201), 'Supplier\nName']) {
        assert.throws(() => mockInvoiceInput({ supplierName, amountRon: '1.00' }));
    }
    for (const amountRon of [undefined, 10, '', '0', '0.00', '-1', '1.234', '1e3', '1,234.50', '1000000000', 'NaN']) {
        assert.throws(() => mockInvoiceInput({ supplierName: 'Supplier', amountRon }));
    }
});

function harness(initialized: boolean) {
    const xml = strToU8(sampleXml(1, '12345678', '2026-09-25'));
    const archive = zipSync({ 'invoice.xml': xml });
    const invoices = new Map<string, Invoice>();
    const events = new Map<string, Event>();
    const files = new Map<string, Uint8Array>();
    const published: string[] = [];
    let emailCount = 0;
    let failEmail = false;
    const repo = {
        company: async () => ({ id: 'company', initialized, lastSync: null }),
        hasInvoice: async (id: string) => invoices.has(id),
        insertInvoice: async (id: string, data: Invoice, notify: boolean) => {
            invoices.set(id, { ...data, id, messageId: id, pdfReady: false, createdAt: '' });
            for (const kind of ['invoice.pdf', ...(notify ? ['invoice.email'] : [])]) {
                const eventId = `${id}:${kind}`;
                events.set(eventId, { id: eventId, companyId: 'company', invoiceId: id, kind: kind as Event['kind'], status: 'pending', attempts: 0, error: null, createdAt: '' });
            }
        },
        finishSync: async () => { initialized = true; },
        pendingEvents: async () => [...events.values()].filter(e => !published.includes(e.id)),
        markPublished: async (id: string) => { published.push(id); },
        event: async (id: string) => events.get(id) ?? null,
        invoice: async (id: string) => invoices.get(id) ?? null,
        completeEvent: async (id: string, skipped: boolean) => { events.get(id)!.status = skipped ? 'skipped' : 'sent'; },
        failEvent: async (id: string) => { events.get(id)!.attempts++; },
        pdfReady: async (id: string) => { invoices.get(id)!.pdfReady = true; },
    } as unknown as Repository;
    const gateway: AnafGateway = {
        list: async () => [{ id: '900001', tip: 'FACTURA PRIMITA', data_creare: '', detalii: '' }],
        download: async () => archive,
        pdf: async () => Buffer.from('%PDF-test'),
    };
    const fileStore = { put: async (id: string, kind: string, data: Uint8Array) => { files.set(`${id}.${kind}`, data); },
        read: async (id: string, kind: string) => Buffer.from(files.get(`${id}.${kind}`)!) } as InvoiceFiles;
    const queue = { publish: async () => {} } as unknown as JobQueue;
    const email: NotificationChannel = { send: async () => { if (failEmail) throw new Error('SMTP unavailable'); emailCount++; } };
    return { repo, events, invoices, files, gateway, queue,
        workflows: new Workflows(repo, gateway, fileStore, queue, email, true),
        emailCount: () => emailCount, failEmail: (value: boolean) => { failEmail = value; } };
}

test('initial import suppresses individual emails and repeated sync does not create new work', async () => {
    const h = harness(false);
    await h.workflows.sync();
    await h.workflows.sync();
    assert.equal(h.invoices.size, 1);
    assert.deepEqual([...h.events.values()].map(e => e.kind), ['invoice.pdf']);
    assert.ok(h.files.has('900001.zip'));
});

test('SMTP failure does not block PDF or invoice storage; retry and redelivery are safe after success', async () => {
    const h = harness(true);
    await h.workflows.sync();
    h.failEmail(true);
    await assert.rejects(h.workflows.event('900001:invoice.email'), /Background task failed/);
    await h.workflows.event('900001:invoice.pdf');
    assert.equal(h.invoices.get('900001')!.pdfReady, true);
    assert.equal(h.events.get('900001:invoice.email')!.status, 'pending');
    h.failEmail(false);
    await h.workflows.event('900001:invoice.email');
    await h.workflows.event('900001:invoice.email');
    assert.equal(h.emailCount(), 1);
});

test('outbox publishing failure leaves event eligible for later dispatch', async () => {
    const h = harness(true);
    await h.workflows.sync();
    h.queue.publish = async () => { throw new Error('Queue unavailable'); };
    await assert.rejects(h.workflows.dispatch());
    assert.equal((await h.repo.pendingEvents()).length, 2);
});

test('invoice amount includes VAT regardless of paid amounts, outstanding balances or rounding', () => {
    for (const [paid, balance, rounding] of [['145.20', '0.00', '0.00'], ['45.20', '100.00', '0.00'], ['0.00', '145.22', '0.02']]) {
        const xml = sampleXml(1, '12345678', '2026-09-25').replace(
            '<cbc:PayableAmount currencyID="RON">145.20</cbc:PayableAmount>',
            `<cbc:PrepaidAmount currencyID="RON">${paid}</cbc:PrepaidAmount>
            <cbc:PayableRoundingAmount currencyID="RON">${rounding}</cbc:PayableRoundingAmount>
            <cbc:PayableAmount currencyID="RON">${balance}</cbc:PayableAmount>`,
        );
        const invoice = parseInvoice(strToU8(xml));
        assert.equal(invoice.total, '145.20');
        assert.equal(invoice.net, '120.00');
        assert.equal(invoice.totalBasis, 'tax-inclusive');
    }
    const paidWithoutVat = sampleXml(2, '12345678', '2026-09-25', { supplierName: 'Public institution', amountRon: '30.25' })
        .replace('<cbc:PayableAmount currencyID="RON">30.25</cbc:PayableAmount>',
            '<cbc:PrepaidAmount currencyID="RON">30.25</cbc:PrepaidAmount><cbc:PayableAmount currencyID="RON">0.00</cbc:PayableAmount>');
    assert.equal(parseInvoice(strToU8(paidWithoutVat)).total, '30.25');
    const creditNote = paidWithoutVat.replace(/Invoice/g, 'CreditNote').replace(/InvoicedQuantity/g, 'CreditedQuantity');
    assert.equal(parseInvoice(strToU8(creditNote)).total, '30.25');
});
