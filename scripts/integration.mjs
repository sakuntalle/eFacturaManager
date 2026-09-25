import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Explicitly target the local development stack. Never reads real SMTP credentials.
const origin = 'http://localhost:3100';
let cookie = '';
async function api(path, body) {
    const response = await fetch(`${origin}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (path === 'login') cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
}
async function until(description, check) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await delay(1000);
    }
    throw new Error(`Timed out: ${description}`);
}
assert.equal((await fetch(`${origin}/api/invoices`)).status, 401, 'Invoices require sign-in');
assert.equal((await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' })).status, 403, 'Cross-origin mutation rejected');
await api('login', { email: 'admin@example.test', password: 'local-development-only' });
const status = await api('status');
assert.equal(status.mode, 'mock', 'Integration test requires mock mode');
assert.equal(status.emailTo, 'developer@example.test', 'Integration test requires local test recipient');
await api('mock', { action: 'scenario', value: 'normal' });
await api('sync', {});
await until('initial sync', async () => (await api('status')).company.initialized);
const before = await api('invoices');
assert.ok(before.length >= 3);
const mockBefore = await api('mock');
const invalid = await fetch(`${origin}/api/mock`, { method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'invoice', supplierName: 'Invalid amount', amountRon: '0' }) });
assert.equal(invalid.status, 400);
assert.equal((await api('mock')).count, mockBefore.count, 'Invalid form does not create an invoice');
const created = await api('mock', { action: 'invoice', supplierName: 'Integration & Supplies <SRL>', amountRon: '987,65' });
await api('sync', {});
const invoice = await until('new invoice', async () => (await api('invoices')).find(i => !before.some(old => old.id === i.id)));
assert.equal(invoice.number, created.created.number);
assert.equal(invoice.supplier, 'Integration & Supplies <SRL>');
assert.equal(invoice.total, '987.65');
assert.equal(invoice.tax, '0.00');
await until('PDF and email events complete', async () => {
    const jobs = (await api('events')).filter(e => e.invoiceId === invoice.id);
    return jobs.length === 2 && jobs.every(e => e.status === 'sent');
});
for (const [kind, signature] of [['zip', 'PK'], ['pdf', '%PDF-']]) {
    const response = await fetch(`${origin}/api/invoices/${invoice.id}/${kind}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, signature.length).toString(), signature);
}
const mail = await until('captured SMTP message', async () => {
    const result = await (await fetch('http://localhost:8025/api/v1/messages')).json();
    return result.messages?.find(m => m.Subject.includes(invoice.number));
});
assert.match(mail.Subject, /SIMULATED ANAF/);
assert.ok(mail.Subject.includes(invoice.supplier));
const message = await (await fetch(`http://localhost:8025/api/v1/message/${mail.ID}`)).json();
assert.ok(message.Text.includes('987.65 RON'), 'Email contains the entered amount');
await api('sync', {});
await delay(2500);
assert.equal((await api('invoices')).length, before.length + 1, 'Repeated sync does not duplicate invoices');
const inbox = await (await fetch('http://localhost:8025/api/v1/messages')).json();
assert.equal(inbox.messages.filter(m => m.Subject.includes(invoice.number)).length, 1, 'Repeated sync does not duplicate email');
await api('settings', { pollSeconds: 45 });
assert.equal((await api('status')).company.pollSeconds, 45);
await api('settings', { pollSeconds: status.company.pollSeconds });
try {
    await api('mock', { action: 'scenario', value: 'server-error' });
    await api('sync', {});
    await until('visible ANAF outage', async () => (await api('status')).company.syncError?.includes('503'));
    assert.equal((await api('invoices')).length, before.length + 1, 'Stored invoices remain available during outage');
    await api('mock', { action: 'scenario', value: 'normal' });
    await until('automatic sync retry recovery', async () => !(await api('status')).company.syncError);
    await api('mock', { action: 'scenario', value: 'pdf-error' });
    const next = await api('mock', { action: 'invoice', supplierName: 'PDF recovery supplier', amountRon: '10.01' });
    assert.equal(Number(next.created.number.slice(5)), Number(created.created.number.slice(5)) + 1, 'Invoice numbers increment automatically');
    await api('sync', {});
    const independent = await until('invoice during PDF outage', async () => (await api('invoices')).find(i => i.id !== invoice.id && !before.some(old => old.id === i.id)));
    await until('email independent of PDF failure', async () => {
        const events = (await api('events')).filter(e => e.invoiceId === independent.id);
        return events.some(e => e.kind === 'invoice.email' && e.status === 'sent')
            && events.some(e => e.kind === 'invoice.pdf' && e.attempts >= 1);
    });
    await api('mock', { action: 'scenario', value: 'normal' });
    await until('PDF retry recovery', async () => (await api(`invoices/${independent.id}`)).pdfReady);
} finally {
    await api('mock', { action: 'scenario', value: 'normal' });
}
console.log('PASS: authentication, CSRF, PostgreSQL/queue/outbox, ZIP/PDF, SMTP capture, deduplication, settings, outage recovery and independent PDF/email retries.');
