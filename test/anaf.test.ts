import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnafClient, getTokens, receivedInvoices } from '../src/anaf.ts';
import type { Fetch } from '../src/anaf.ts';
import { authorizationUrl, localRedirect, callbackCode, login } from '../src/oauth.ts';
import { readTokens, saveArchive, saveTokens } from '../src/storage.ts';

const fixture = { id: '123456', tip: 'FACTURA PRIMITA', data_creare: '202609251100', detalii: 'Synthetic invoice' };
const reply = (data: unknown, status = 200): Fetch => async () => Response.json(data, { status });

test('list uses OAuth API host, selected environment, company/window and received filter', async () => {
    const fetcher: Fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://api.anaf.ro');
        assert.equal(url.pathname, '/test/FCTEL/rest/listaMesajeFactura');
        assert.equal(url.searchParams.get('cif'), '1234');
        assert.equal(url.searchParams.get('zile'), '7');
        assert.equal(url.searchParams.get('filtru'), 'P');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret-token');
        assert.equal(init?.redirect, 'error');
        return Response.json({ mesaje: [fixture] });
    };
    assert.deepEqual(await new AnafClient('test', 'secret-token', fetcher).list('1234', 7), [fixture]);
});

test('recognizes documented no-message response and an empty array', async () => {
    for (const data of [{ eroare: 'Nu exista mesaje in intervalul selectat', titlu: 'Lista Mesaje' }, { mesaje: [] }]) {
        assert.deepEqual(await new AnafClient('prod', 't', reply(data)).list('1234', 1), []);
    }
});

test('HTTP 200 application errors are failures, with sensitive bodies omitted', async () => {
    const client = new AnafClient('prod', 't', reply({ eroare: 'secret-body' }));
    await assert.rejects(client.list('1234', 7), error => error instanceof Error
        && /application error/.test(error.message) && !error.message.includes('secret-body'));
});

test('unexpected schemas and unsafe IDs are rejected', async () => {
    for (const data of [{}, { mesaje: [{ ...fixture, id: '../../tokens' }] }, { mesaje: [{ ...fixture, id: 123 }] }]) {
        await assert.rejects(new AnafClient('test', 't', reply(data)).list('1234', 7));
    }
});

test('invalid selection never reaches ANAF', async () => {
    const client = new AnafClient('prod', 't', async () => { assert.fail('Network must not be called'); });
    await assert.rejects(client.list('1234', 61));
    await assert.rejects(client.list('1234', 0));
    await assert.rejects(client.list('not-a-cif', 7));
    await assert.rejects(client.download('../bad'));
});

test('handles authorization, rate limiting and server errors without leaking bodies', async () => {
    for (const status of [401, 403, 429, 500]) {
        await assert.rejects(new AnafClient('prod', 't', reply({ secret: 'do-not-print' }, status)).list('1234', 7),
            error => error instanceof Error && error.message.includes(String(status)) && !error.message.includes('do-not-print'));
    }
});

test('network failures are sanitized', async () => {
    const client = new AnafClient('prod', 't', async () => { throw new Error('secret-request'); });
    await assert.rejects(client.list('1234', 7), error => error instanceof Error
        && /request failed/.test(error.message) && !error.message.includes('secret-request'));
});

test('received selection excludes outgoing invoices and errors, accepting diacritics', () => {
    assert.deepEqual(receivedInvoices([fixture, { ...fixture, id: '2', tip: 'FACTURA PRIMITĂ' },
        { ...fixture, tip: 'FACTURA TRIMISA' }, { ...fixture, tip: 'ERORI FACTURA' }]).map(m => m.id), ['123456', '2']);
});

test('download preserves bytes and uses the message ID, not upload ID', async () => {
    // Only ZIP magic detection is tested here. This POC does not extract/validate archive contents.
    const bytes = Buffer.alloc(30);
    bytes.set([0x50, 0x4b, 3, 4]);
    const fetcher: Fetch = async (input, init) => {
        assert.equal(String(input), 'https://api.anaf.ro/prod/FCTEL/rest/descarcare?id=123456');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer t');
        return new Response(bytes);
    };
    assert.deepEqual(Buffer.from(await new AnafClient('prod', 't', fetcher).download('123456')), bytes);
});

test('download rejects HTTP 200 JSON/HTML errors rather than writing a fake archive', async () => {
    for (const body of ['{"eroare":"secret"}', '<html>Gateway error</html>', 'PK']) {
        await assert.rejects(new AnafClient('prod', 't', async () => new Response(body)).download('123456'), /not a ZIP/);
    }
});

test('authorization URL uses JWT and unpredictable state supplied by the caller', () => {
    const url = new URL(authorizationUrl('app-id', 'https://localhost:8765/callback', 'random-state'));
    assert.equal(url.origin, 'https://logincert.anaf.ro');
    assert.equal(url.searchParams.get('token_content_type'), 'jwt');
    assert.equal(url.searchParams.get('state'), 'random-state');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://localhost:8765/callback');
    assert.equal(url.searchParams.has('client_secret'), false);
});

test('callback listener requires HTTPS and an explicitly local address', () => {
    assert.equal(localRedirect('https://localhost:8765/callback').port, '8765');
    assert.equal(localRedirect('https://127.0.0.1:8765/callback').hostname, '127.0.0.1');
    for (const url of ['https://example.com:8765/callback', 'https://0.0.0.0:8765/callback',
        'https://user:secret@localhost:8765/callback', 'https://localhost/callback', 'https://localhost:8765/callback?x=y',
        'http://localhost:8765/callback', 'https://localhost:0/callback', 'https://localhost:8765/callback#fragment']) {
        assert.throws(() => localRedirect(url));
    }
});

test('HTTPS login requires local certificate files before contacting ANAF', async () => {
    const cfg = { clientId: 'test-id', clientSecret: 'test-secret', redirectUri: 'https://localhost:8765/callback' };
    await assert.rejects(login(cfg, async () => {}), /ANAF_TLS_CERT_FILE/);
    await assert.rejects(login({ ...cfg, tlsCertFile: 'missing-cert.pem', tlsKeyFile: 'missing-key.pem' }, async () => {}), /Cannot read the local HTTPS/);
});

test('callback rejects missing/mismatched/duplicated state, duplicate code and authorization errors', () => {
    const url = (query: string) => new URL(`https://localhost:8765/callback?${query}`);
    assert.equal(callbackCode(url('state=expected&code=one-use-code'), 'expected'), 'one-use-code');
    for (const query of ['code=secret', 'state=wrong&code=secret',
        'state=expected&state=wrong&code=secret', 'state=expected',
        'state=expected&code=a&code=secret', 'state=expected&error=denied&error_description=secret']) {
        assert.throws(() => callbackCode(url(query), 'expected'), error => error instanceof Error && !error.message.includes('secret'));
    }
});

test('token exchange uses Basic auth and form encoding; refresh token rotation is preserved', async () => {
    const fetcher: Fetch = async (input, init) => {
        assert.equal(String(input), 'https://logincert.anaf.ro/anaf-oauth2/v1/token');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('id:secret').toString('base64')}`);
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'old+refresh&token');
        return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' });
    };
    const tokens = await getTokens({ clientId: 'id', clientSecret: 'secret' },
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'old+refresh&token' }), fetcher);
    assert.equal(tokens.access_token, 'new-access');
    assert.equal(tokens.refresh_token, 'new-refresh');
});

test('malformed OAuth success and OAuth error bodies do not leak secrets', async () => {
    await assert.rejects(getTokens({ clientId: 'id', clientSecret: 'secret' }, new URLSearchParams(),
        reply({ error: 'invalid_grant', error_description: 'secret-code' })),
    error => error instanceof Error && !error.message.includes('secret-code'));
});

test('token storage replaces old tokens and restricts permissions on POSIX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anaf-poc-'));
    try {
        await saveTokens(root, { access_token: 'old', obtained_at: '' });
        await saveTokens(root, { access_token: 'new', refresh_token: 'rotated', obtained_at: '' });
        assert.equal((await readTokens(join(root, 'tokens.json'))).refresh_token, 'rotated');
        if (process.platform !== 'win32') assert.equal((await stat(join(root, 'tokens.json'))).mode & 0o777, 0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('archives are scoped by environment/company and originals cannot be overwritten', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anaf-poc-'));
    try {
        const path = await saveArchive(root, 'prod', '1234', '5678', Buffer.from('original'));
        assert.equal(path, join(root, 'prod', '1234', '5678.zip'));
        await assert.rejects(saveArchive(root, 'prod', '1234', '5678', Buffer.from('changed')), { code: 'EEXIST' });
        assert.equal(await readFile(path, 'utf8'), 'original');
        await assert.rejects(saveArchive(root, 'prod', '../1234', '5678', Buffer.from('bad')));
    } finally { await rm(root, { recursive: true, force: true }); }
});
