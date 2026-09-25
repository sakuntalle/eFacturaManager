import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../app/config.js';
import { AnafConnection, type ConnectionRecord, type ConnectionStore, type ConnectionTransaction, type OAuthAttempt, type OAuthGateway } from '../app/connection.js';
import { AnafHttpError, type Tokens } from '../src/anaf.js';

class MemoryStore implements ConnectionStore {
    row: ConnectionRecord | null = null;
    pending: OAuthAttempt | null = null;
    session = true;
    resumed = 0;
    private lock = Promise.resolve();
    async hasSession() { return this.session; }
    async connection() { return this.row; }
    async withConnectionLock<T>(work: (tx: ConnectionTransaction) => Promise<T>): Promise<T> {
        const previous = this.lock;
        let release!: () => void;
        this.lock = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            return await work({ read: async () => this.row, write: async row => { this.row = row; },
                attempt: async () => this.pending, saveAttempt: async attempt => { this.pending = attempt; },
                resume: async () => { this.resumed++; }, hasSession: async () => this.session });
        } finally { release(); }
    }
}
const cfg = config({ ANAF_MODE: 'live', ANAF_CIF: '12345', APP_PUBLIC_URL: 'https://localhost:8765',
    ANAF_CLIENT_ID: 'dummy-client-id', ANAF_CLIENT_SECRET: 'dummy-client-secret', ANAF_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') });
function fixture(expires = 3600) {
    const store = new MemoryStore();
    let refreshCount = 0;
    const gateway: OAuthGateway = {
        exchange: async () => ({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', obtained_at: new Date().toISOString(), expires_in: expires }),
        refresh: async token => {
            assert.equal(token, refreshCount ? 'rotated-refresh-token' : 'private-refresh-token');
            refreshCount++;
            return { access_token: `refreshed-${refreshCount}`, refresh_token: 'rotated-refresh-token', obtained_at: new Date().toISOString(), expires_in: 3600 };
        },
        verify: async () => {},
    };
    const connection = new AnafConnection(cfg, store, gateway);
    const callback = (start: { url: string }) => new URL(`https://localhost:8765/callback?state=${new URL(start.url).searchParams.get('state')}&code=one-time-code`);
    const connect = async () => { const start = await connection.begin('session-hash'); assert.equal(await connection.complete(callback(start), start.binding), true); };
    return { connection, store, gateway, callback, connect, refreshCount: () => refreshCount };
}
test('connection stores encrypted tokens, returns only safe status, and binds single-use callback to browser and app session', async () => {
    const f = fixture();
    const start = await f.connection.begin('session-hash');
    assert.equal(await f.connection.complete(f.callback(start), '0'.repeat(64)), false);
    assert.equal(await f.connection.complete(f.callback(start), start.binding), true);
    assert.equal(await f.connection.complete(f.callback(start), start.binding), false);
    const stored = JSON.stringify(f.store.row);
    for (const secret of ['private-access-token', 'private-refresh-token', cfg.oauth.clientId, cfg.oauth.clientSecret]) assert.equal(stored.includes(secret), false);
    assert.deepEqual(Object.keys(await f.connection.status()).sort(), ['canConnect', 'connectedAt', 'state']);
    assert.equal(await f.connection.withAccessToken(async token => token), 'private-access-token');
    assert.equal(f.store.resumed, 1);
});
test('expired, ambiguous and logged-out callbacks never exchange tokens', async () => {
    for (const kind of ['expiry', 'logout', 'duplicate', 'denied']) {
        const f = fixture();
        f.gateway.exchange = async () => { assert.fail('Must not exchange'); };
        const start = await f.connection.begin('session-hash');
        const url = f.callback(start);
        if (kind === 'expiry') f.store.pending!.expires = 0;
        if (kind === 'logout') f.store.session = false;
        if (kind === 'duplicate') url.searchParams.append('code', 'other');
        if (kind === 'denied') url.searchParams.set('error', 'sensitive-error');
        assert.equal(await f.connection.complete(url, start.binding), false);
        assert.notEqual((await f.connection.status()).state, 'connected');
    }
});
test('company access must succeed before connection becomes usable', async () => {
    const f = fixture();
    f.gateway.verify = async () => { throw new Error('private-response'); };
    const start = await f.connection.begin('session-hash');
    assert.equal(await f.connection.complete(f.callback(start), start.binding), false);
    assert.equal(f.store.row, null);
});
test('concurrent workers refresh once, persist rotated credentials, and retry rejected API tokens once', async () => {
    const f = fixture(1);
    await f.connect();
    const second = new AnafConnection(cfg, f.store, f.gateway);
    assert.deepEqual(await Promise.all([f.connection.withAccessToken(async t => t), second.withAccessToken(async t => t)]), ['refreshed-1', 'refreshed-1']);
    assert.equal(f.refreshCount(), 1);
    let calls = 0;
    assert.equal(await second.withAccessToken(async token => {
        if (++calls === 1) throw new AnafHttpError(401, 'Unauthorized');
        return token;
    }), 'refreshed-2');
    assert.equal(calls, 2);
});
test('temporary refresh failure preserves connection; rejected refresh requests renewal and removes tokens', async () => {
    const f = fixture(1);
    await f.connect();
    f.gateway.refresh = async () => { throw new AnafHttpError(503, 'private-response'); };
    await assert.rejects(f.connection.withAccessToken(async () => true), /temporarily unavailable/);
    assert.equal((await f.connection.status()).state, 'connected');
    assert.ok(f.store.row?.encrypted);
    f.gateway.refresh = async () => { throw new AnafHttpError(400, 'private-response'); };
    await assert.rejects(f.connection.withAccessToken(async () => true), /Connect to ANAF/);
    assert.equal((await f.connection.status()).state, 'reconnect_required');
    assert.equal(f.store.row?.encrypted, null);
});
test('disconnect cancels pending callback and prevents further requests', async () => {
    const f = fixture();
    await f.connect();
    const pending = await f.connection.begin('session-hash');
    await f.connection.disconnect();
    assert.equal(await f.connection.complete(f.callback(pending), pending.binding), false);
    await assert.rejects(f.connection.withAccessToken(async () => assert.fail('No API call')), /Connect to ANAF/);
    assert.equal((await f.connection.status()).state, 'disconnected');
    assert.equal(f.store.row?.encrypted, null);
});
test('tampered ciphertext and configuration changes cannot reuse saved tokens', async () => {
    const f = fixture();
    await f.connect();
    const changed = new AnafConnection({ ...cfg, cif: '99999' }, f.store, f.gateway);
    assert.equal((await changed.status()).state, 'reconnect_required');
    await assert.rejects(changed.withAccessToken(async () => assert.fail()), /Connect to ANAF/);
    f.store.row!.encrypted = 'tampered';
    await assert.rejects(f.connection.withAccessToken(async () => assert.fail()), /Connect to ANAF/);
    assert.equal((await f.connection.status()).state, 'reconnect_required');
});
test('mock and incomplete live deployments never authorize with a fallback token', async () => {
    const store = new MemoryStore();
    for (const mode of ['mock', 'live'] as const) {
        const connection = new AnafConnection(config({ ANAF_MODE: mode, ANAF_CIF: '12345', ANAF_ACCESS_TOKEN: 'old-token' }), store);
        assert.equal((await connection.status()).state, mode === 'mock' ? 'mock' : 'unconfigured');
        await assert.rejects(connection.begin('session'), /Connect to ANAF/);
    }
});

test('changing app login credentials invalidates an outstanding authorization without disconnecting an existing grant', async () => {
    const f = fixture();
    await f.connect();
    const start = await f.connection.begin('session-hash');
    const restarted = new AnafConnection({ ...cfg, password: 'a-new-admin-password' }, f.store, f.gateway);
    assert.equal(await restarted.complete(f.callback(start), start.binding), false);
    assert.equal((await restarted.status()).state, 'connected');
});

test('immediate provider refusal after disconnect is classified safely and a fresh reconnect succeeds', async () => {
    const f = fixture();
    await f.connect();
    await f.connection.disconnect();
    const failed = await f.connection.begin('session-hash');
    const url = f.callback(failed);
    url.searchParams.delete('code');
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'private-token-or-registration-detail');
    const diagnostics: unknown[] = [];
    assert.equal(await f.connection.complete(url, failed.binding, (step, status) => diagnostics.push({ step, status })), false);
    assert.deepEqual(diagnostics, [{ step: 'provider_access_denied', status: undefined }]);
    assert.equal(f.store.row?.encrypted, null);
    assert.equal((await f.connection.status()).state, 'disconnected');
    await f.connect();
    assert.equal((await f.connection.status()).state, 'connected');
    assert.equal(await f.connection.withAccessToken(async token => token), 'private-access-token');
});

test('certificate gateway logout without a callback leaves the app disconnected and permits a fresh attempt', async () => {
    const f = fixture();
    await f.connect();
    await f.connection.disconnect();
    const abandoned = await f.connection.begin('session-hash');
    assert.equal((await f.connection.status()).state, 'disconnected');

    const retry = await f.connection.begin('session-hash');
    assert.notEqual(new URL(abandoned.url).searchParams.get('state'), new URL(retry.url).searchParams.get('state'));
    assert.equal(await f.connection.complete(f.callback(abandoned), abandoned.binding), false);
    assert.equal((await f.connection.status()).state, 'disconnected');
    assert.equal(await f.connection.complete(f.callback(retry), retry.binding), true);
    assert.equal((await f.connection.status()).state, 'connected');
});

test('ANAF access denied guidance covers a certificate gateway logout without blaming the certificate', async () => {
    const { connectionFailureMessage } = await import('../app/connection-errors.js');
    const message = connectionFailureMessage('provider_access_denied');
    assert.match(message, /Your session is finished/);
    assert.match(message, /OAuth app registration/);
    assert.doesNotMatch(message, /close and reopen your browser|certificate is available/i);
});

test('unknown provider errors cannot enter diagnostics or UI text', async () => {
    const { connectionFailureMessage, providerFailure } = await import('../app/connection-errors.js');
    const sensitive = 'private-token-or-registration-detail';
    assert.equal(providerFailure(sensitive), 'authorization_declined');
    for (const reason of [sensitive, 'constructor', '__proto__', null, 'provider_access_denied']) {
        assert.equal(typeof connectionFailureMessage(reason), 'string');
        assert.equal(connectionFailureMessage(reason).includes(sensitive), false);
    }
    const f = fixture();
    const start = await f.connection.begin('session-hash');
    const url = f.callback(start);
    url.searchParams.set('error', sensitive);
    const diagnostics: unknown[] = [];
    assert.equal(await f.connection.complete(url, start.binding, (step, status) => diagnostics.push({ step, status })), false);
    assert.deepEqual(diagnostics, [{ step: 'authorization_declined', status: undefined }]);
});
