import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { samplePdf, sampleXml } from './fixtures.js';
import { mockInvoiceInput } from './invoice-input.js';
import type { MockInvoiceInput } from './invoice-input.js';

type Entry = { id: string; sequence: number; created: number } & Partial<MockInvoiceInput>;
const stateFile = resolve(process.env.MOCK_STATE_FILE ?? '.local/mock/invoices.json');
const cif = (process.env.ANAF_CIF || '12345678').replace(/^RO/i, '');
if (!/^\d{1,30}$/.test(cif)) throw new Error('Invalid mock company CIF.');
let entries: Entry[];
try { entries = JSON.parse(await readFile(stateFile, 'utf8')); }
catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    entries = [1, 2, 3].map(sequence => ({ id: String(900000 + sequence), sequence, created: Date.now() - sequence * 60000 }));
}
async function persist(nextEntries = entries) {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(nextEntries, null, 4));
    await rename(`${stateFile}.tmp`, stateFile);
}
await persist();
const scenarios = ['normal', 'rate-limit', 'server-error', 'unauthorized', 'invalid-zip', 'pdf-error'];
let scenario = 'normal';
let mutating = false;
const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    };
    try {
        const url = new URL(req.url ?? '/', 'http://mock.local');
        if (url.pathname === '/health') { json({ ok: true }); return; }
        if (req.headers.authorization !== 'Bearer mock-only-access-token') { json({ eroare: 'Mock token required' }, 401); return; }
        if (url.pathname === '/control') {
            let created: { id: string; number: string } | undefined;
            if (req.method === 'POST') {
                if (mutating) { json({ error: 'Try again' }, 409); return; }
                mutating = true;
                try {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 4096) { json({ error: 'Request too large' }, 413); return; }
                        chunks.push(chunk);
                    }
                    let body;
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                    catch { json({ error: 'Expected a JSON request' }, 400); return; }
                    if (body?.action === 'invoice') {
                        let input: MockInvoiceInput;
                        try { input = mockInvoiceInput(body); }
                        catch (error) { json({ error: error instanceof Error ? error.message : 'Invalid invoice' }, 400); return; }
                        const sequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
                        const entry = { id: String(900000 + sequence), sequence, created: Date.now(), ...input };
                        const nextEntries = [...entries, entry];
                        await persist(nextEntries);
                        entries = nextEntries;
                        created = { id: entry.id, number: `DEMO-${String(sequence).padStart(4, '0')}` };
                    } else if (body?.action === 'scenario' && scenarios.includes(body.value)) {
                        scenario = body.value;
                    } else { json({ error: 'Unsupported control' }, 400); return; }
                } finally { mutating = false; }
            }
            json({ scenario, count: entries.length, scenarios, ...(created ? { created } : {}) }); return;
        }
        if (scenario === 'rate-limit') { res.setHeader('Retry-After', '5'); json({ eroare: 'Simulated limit' }, 429); return; }
        if (scenario === 'server-error') { json({ eroare: 'Simulated outage' }, 503); return; }
        if (scenario === 'unauthorized') { json({ eroare: 'Simulated expired token' }, 401); return; }
        if (/^\/(prod|test)\/FCTEL\/rest\/listaMesajeFactura$/.test(url.pathname) && req.method === 'GET') {
            const days = Number(url.searchParams.get('zile'));
            if (!Number.isInteger(days) || days < 1 || days > 60 || url.searchParams.get('cif') !== cif || url.searchParams.get('filtru') !== 'P') {
                json({ eroare: 'Invalid company, days or filter' }, 400); return;
            }
            const mesaje = entries.filter(e => e.created >= Date.now() - days * 86400000).map(e => ({
                id: e.id, tip: 'FACTURA PRIMITA', cif, id_solicitare: `8${e.id}`,
                data_creare: new Date(e.created).toISOString().replace(/\D/g, '').slice(0, 12),
                detalii: `Simulated received invoice DEMO-${String(e.sequence).padStart(4, '0')}`,
            }));
            json(mesaje.length ? { mesaje } : { eroare: 'Nu exista mesaje in intervalul selectat' }); return;
        }
        if (/^\/(prod|test)\/FCTEL\/rest\/descarcare$/.test(url.pathname) && req.method === 'GET') {
            const entry = entries.find(e => e.id === url.searchParams.get('id'));
            if (!entry) { json({ eroare: 'Unknown message' }, 404); return; }
            if (scenario === 'invalid-zip') { json({ eroare: 'Simulated error with HTTP 200' }); return; }
            const custom = entry.supplierName !== undefined ? mockInvoiceInput(entry) : undefined;
            const xml = sampleXml(entry.sequence, cif, new Date(entry.created).toISOString().slice(0, 10), custom);
            const archive = zipSync({ 'invoice.xml': strToU8(xml), 'signature.xml': strToU8('<MockSignature>NOT A VALID SIGNATURE</MockSignature>') });
            res.writeHead(200, { 'Content-Type': 'application/zip' }).end(Buffer.from(archive)); return;
        }
        if (/^\/prod\/FCTEL\/rest\/transformare\/(FACT1|FCN)$/.test(url.pathname) && req.method === 'POST') {
            if (scenario === 'pdf-error') { json({ eroare: 'Simulated PDF failure' }, 503); return; }
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 2 * 1024 * 1024) { json({ error: 'XML too large' }, 413); return; }
                chunks.push(chunk);
            }
            const pdf = await samplePdf(Buffer.concat(chunks));
            res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(pdf); return;
        }
        json({ error: 'Unknown simulator endpoint' }, 404);
    } catch { if (!res.headersSent) json({ error: 'Simulator request failed' }, 500); else res.end(); }
});
server.listen(Number(process.env.MOCK_PORT ?? 8790), process.env.MOCK_HOST ?? '127.0.0.1', () => console.log('ANAF simulator listening. All invoice data is synthetic.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
