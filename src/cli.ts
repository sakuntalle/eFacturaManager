import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { AnafClient, digits, integer, getTokens, receivedInvoices } from './anaf.ts';
import { login } from './oauth.ts';
import { readTokens, saveTokens, saveArchive } from './storage.ts';
import type { Environment } from './anaf.ts';

const HELP = `ANAF read-only invoice POC (Node.js 24+)

npm run poc -- login                       Authorize with your certificate in a browser
npm run poc -- refresh                     Explicitly refresh saved tokens
npm run poc -- list --days 7               List received messages (metadata only)
npm run poc -- download --days 7 --limit 1  Download up to N received invoice ZIPs
npm run poc -- download --days 60 --id ID   Download a received invoice found in that window

Configuration: copy .env.example to .env and fill in locally.
Downloads: downloads/<prod|test>/<CIF>/<ANAF-message-id>.zip
Tokens: .local/<client-id fingerprint>/tokens.json (plaintext, owner permissions on POSIX).
This POC neither uploads invoices nor sends emails. Help performs no network requests.
Non-paginated listing only: this is not a complete archive/backfill tool.
`;

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Set ${name} in your local .env file.`);
    return value;
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({ options: {
        days: { type: 'string' }, limit: { type: 'string' }, id: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
    }, allowPositionals: true, strict: true });
    const command = positionals[0];
    if (values.help || !command || command === 'help') { console.log(HELP); return; }
    if (positionals.length !== 1 || !['login', 'refresh', 'list', 'download'].includes(command)) {
        throw new Error('Unknown command. Run npm run poc -- help.');
    }
    if (['login', 'refresh'].includes(command) && (values.days || values.limit || values.id)) {
        throw new Error('login/refresh do not accept invoice selection options.');
    }
    if (command === 'list' && (values.id || values.limit)) throw new Error('list only accepts --days.');
    if (values.id && values.limit) throw new Error('Choose --id or --limit, not both.');
    // Separate token files by application registration; changing client ID cannot reuse old tokens.
    const { createHash } = await import('node:crypto');
    const clientId = process.env.ANAF_CLIENT_ID?.trim() ?? '';
    const directory = resolve('.local', createHash('sha256').update(clientId).digest('hex').slice(0, 16));
    const path = join(directory, 'tokens.json');
    const credentials = () => ({ clientId: required('ANAF_CLIENT_ID'), clientSecret: required('ANAF_CLIENT_SECRET') });
    if (command === 'login') {
        await login({ ...credentials(), redirectUri: required('ANAF_REDIRECT_URI'),
            tlsCertFile: required('ANAF_TLS_CERT_FILE'), tlsKeyFile: required('ANAF_TLS_KEY_FILE'),
        }, tokens => saveTokens(directory, tokens));
        console.log('Authorization saved. Next: npm run poc -- list --days 7'); return;
    }
    if (command === 'refresh') {
        if (process.env.ANAF_ACCESS_TOKEN) throw new Error('Remove ANAF_ACCESS_TOKEN to use and refresh locally saved tokens.');
        const auth = credentials();
        const old = await readTokens(path);
        if (!old.refresh_token) throw new Error('No refresh token available. Run login again.');
        const updated = await getTokens(auth, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refresh_token }));
        await saveTokens(directory, { ...updated, refresh_token: updated.refresh_token ?? old.refresh_token });
        console.log('Updated tokens saved locally.'); return;
    }
    const environment = required('ANAF_ENV');
    if (environment !== 'prod' && environment !== 'test') throw new Error('ANAF_ENV must be prod or test.');
    const cif = digits(required('ANAF_CIF').replace(/^RO/i, ''), 'CIF');
    const days = integer(values.days ?? '7', 'days', 1, 60);
    const limit = integer(values.limit ?? '1', 'limit', 1, 10);
    if (values.id) digits(values.id, 'Message ID');
    const token = process.env.ANAF_ACCESS_TOKEN?.trim() || (await readTokens(path)).access_token;
    const client = new AnafClient(environment as Environment, token);
    console.log(`Reading ${environment} messages for CIF ${cif}, last ${days} day(s).`);
    const messages = await client.list(cif, days);
    if (command === 'list') {
        if (!messages.length) console.log('No messages in this window.');
        else console.table(messages);
        console.log('POC listing is not paginated; do not use it to assert archive completeness.');
        return;
    }
    const invoices = receivedInvoices(messages).sort((a, b) => b.data_creare.localeCompare(a.data_creare) || b.id.localeCompare(a.id));
    const selected = values.id ? invoices.filter(m => m.id === values.id) : invoices.slice(0, limit);
    if (values.id && !selected.length) throw new Error('That ID is not a received invoice in the selected company/window. Try --days 60.');
    if (!selected.length) { console.log('No received invoices found in this window.'); return; }
    let failed = 0;
    for (const message of selected) {
        try {
            const bytes = await client.download(message.id);
            const saved = await saveArchive(resolve('downloads'), environment as Environment, cif, message.id, bytes);
            console.log(`Saved ${saved} (${bytes.length} bytes)`);
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
                console.log(`Already saved: ${message.id}.zip (left unchanged).`);
            } else {
                failed++;
                console.error(`Download ${message.id} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    }
    if (failed) throw new Error(`${failed} download(s) failed. Successfully saved files were retained.`);
}

main().catch(error => {
    // No stack traces or HTTP request objects: they can expose secrets.
    console.error(error instanceof Error ? error.message : 'Unexpected failure.');
    process.exitCode = 1;
});
