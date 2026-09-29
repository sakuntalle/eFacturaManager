import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../app/config.js';
import { AnafConnection, type ConnectionStore } from '../app/connection.js';
import { isolatedEnvironment, FIRST_LOGIN_LIVE_ORIGIN, FIRST_LOGIN_MOCK_ORIGIN }
    from '../scripts/first-login-environment.mjs';

test('fresh-login live instance uses a separate database and its own HTTPS ANAF callback', () => {
    const source = new URL('postgres://tester:private@127.0.0.1:55432/live_db');
    const base = { ANAF_MODE: 'live', ANAF_CIF: '12345678', ANAF_CLIENT_ID: 'private-id',
        ANAF_CLIENT_SECRET: 'private-secret', ANAF_TOKEN_ENCRYPTION_KEY: 'private-key',
        ANAF_REDIRECT_URI: 'https://localhost:8765/callback' };
    const live = isolatedEnvironment(source, 'efactura_first_login_123456789abc', 'live', base);
    assert.equal(new URL(live.DATABASE_URL).pathname, '/efactura_first_login_123456789abc');
    assert.equal(live.APP_DATABASE_NAME, 'efactura_first_login_123456789abc');
    assert.equal(live.ANAF_MODE, 'live');
    assert.equal(live.APP_PUBLIC_URL, FIRST_LOGIN_LIVE_ORIGIN);
    assert.equal(live.ANAF_REDIRECT_URI, `${FIRST_LOGIN_LIVE_ORIGIN}/callback`);
    assert.equal(live.APP_TLS_PORT, new URL(FIRST_LOGIN_LIVE_ORIGIN).port);
    assert.ok(live.APP_TLS_CERT_FILE && live.APP_TLS_KEY_FILE);
    assert.equal(live.EMAIL_ENABLED, 'false');
    assert.equal(base.ANAF_REDIRECT_URI, 'https://localhost:8765/callback',
        'The live installation callback must remain unchanged');
    const mock = isolatedEnvironment(source, 'efactura_first_login_123456789abc', 'mock', base);
    assert.equal(mock.ANAF_MODE, 'mock');
    assert.equal(mock.APP_PUBLIC_URL, FIRST_LOGIN_MOCK_ORIGIN);
    assert.equal(mock.APP_TLS_CERT_FILE, '');
});

test('new connection in the isolated live workspace is disconnected and can be authorized', async () => {
    const base = { ANAF_CIF: '12345678', ANAF_CLIENT_ID: 'private-id', ANAF_CLIENT_SECRET: 'private-secret',
        ANAF_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    const env = isolatedEnvironment(new URL('postgres://tester:private@127.0.0.1:55432/live_db'),
        'efactura_first_login_123456789abc', 'live', base);
    const store: ConnectionStore = {
        connection: async () => null,
        hasSession: async () => false,
        withConnectionLock: async () => { throw new Error('No connection lock should be needed for status.'); },
    };
    assert.deepEqual(await new AnafConnection(config(env), store).status(),
        { state: 'disconnected', canConnect: true, connectedAt: null });
});
