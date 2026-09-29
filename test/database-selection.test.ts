import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../app/config.js';

test('named database selection changes only the database, preserving connection credentials and live OAuth settings', () => {
    const base = 'postgres://efactura:private-password@127.0.0.1:55432/efactura?sslmode=disable';
    const env = { DATABASE_URL: base, ANAF_MODE: 'live', ANAF_CIF: '12345678',
        ANAF_REDIRECT_URI: 'https://localhost:8765/callback', APP_PUBLIC_URL: 'https://localhost:8765' };
    const current = config(env);
    const fresh = config({ ...env, APP_DATABASE_NAME: 'efactura_onboarding' });
    assert.equal(current.databaseUrl, base);
    assert.equal(fresh.databaseUrl, 'postgres://efactura:private-password@127.0.0.1:55432/efactura_onboarding?sslmode=disable');
    assert.equal(fresh.oauth.redirectUri, current.oauth.redirectUri);
    assert.equal(fresh.publicUrl, current.publicUrl);
});

test('named database selection rejects names that could alter the connection URL or SQL identifier', () => {
    for (const name of ['../postgres', 'efactura?sslmode=disable', 'DB-Name', 'a'.repeat(64), '123db', 'other/db']) {
        assert.throws(() => config({ APP_DATABASE_NAME: name }), /APP_DATABASE_NAME/);
    }
});
