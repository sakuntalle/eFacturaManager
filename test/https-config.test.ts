import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config as appConfig } from '../app/config.js';
import { failureDetails } from '../app/diagnostics.js';

// The refactored app requires explicit database and document storage settings.
function config(env: NodeJS.ProcessEnv) {
    return appConfig({ DATABASE_URL: 'postgres://localhost/efactura_test', DATA_DIR: '.local/test', ...env });
}

const docker = { APP_REQUIRE_HTTPS: 'true', APP_TLS_PORT: '8765' };
const tls = { APP_TLS_CERT_FILE: 'test-cert.pem', APP_TLS_KEY_FILE: 'test-key.pem' };

test('Docker rejects legacy HTTP public URLs before accepting browser requests', () => {
    for (const extra of [{}, tls]) {
        assert.throws(() => config({ ...docker, ...extra, APP_PUBLIC_URL: 'http://localhost:3100' }),
            /APP_PUBLIC_URL must be an HTTPS origin/);
    }
    assert.throws(() => config({ ...tls, APP_PUBLIC_URL: 'http://localhost:3100' }), /HTTPS origin/);
});

test('Docker HTTPS origins match the listener port and accept custom TLS ports', () => {
    assert.equal(config(docker).publicUrl, 'https://localhost:8765');
    const custom = config({ ...docker, ...tls, APP_TLS_PORT: '9876', APP_PUBLIC_URL: 'https://localhost:9876' });
    assert.equal(custom.publicUrl, 'https://localhost:9876');
    assert.equal(custom.tls.port, 9876);
    assert.equal(custom.port, 9876);
    assert.throws(() => config({ ...docker, APP_PUBLIC_URL: 'https://localhost:9876' }), /must match APP_TLS_PORT/);
    assert.equal(config({ ...docker, APP_TLS_PORT: '443', APP_PUBLIC_URL: 'https://localhost' }).tls.port, 443);
});

test('blank Compose URL settings derive the public origin and callback from the single TLS port', () => {
    for (const port of ['8765', '9876', '443']) {
        const cfg = config({ APP_REQUIRE_HTTPS: 'true', APP_TLS_PORT: port,
            APP_PUBLIC_URL: '', ANAF_REDIRECT_URI: '' });
        const expected = new URL(`https://localhost:${port}`).origin;
        assert.equal(cfg.publicUrl, expected);
        assert.equal(cfg.oauth.redirectUri, `${expected}/callback`);
        assert.equal(cfg.tls.port, Number(port));
    }
    const overridden = config({ ...docker, APP_PUBLIC_URL: 'https://localhost:8765',
        ANAF_REDIRECT_URI: 'https://localhost:8765/custom-callback' });
    assert.equal(overridden.oauth.redirectUri, 'https://localhost:8765/custom-callback');
});

test('HTTPS deployment validation rejects invalid origins, ports and partial certificates', () => {
    for (const url of ['https://user:password@localhost:8765', 'https://localhost:8765/path',
        'https://localhost:8765/?query=1', 'https://localhost:8765/#fragment']) {
        assert.throws(() => config({ ...docker, APP_PUBLIC_URL: url }), /HTTPS origin/);
    }
    for (const port of ['0', '-1', '65536', '1.5', 'invalid']) {
        assert.throws(() => config({ ...docker, APP_PUBLIC_URL: 'https://localhost:8765', APP_TLS_PORT: port }), /APP_TLS_PORT/);
        assert.throws(() => config({ ...docker, APP_TLS_PORT: port }), /APP_TLS_PORT/);
    }
    assert.throws(() => config({ ...docker, APP_PUBLIC_URL: 'https://localhost:invalid' }), /HTTPS origin/);
    assert.throws(() => config({ ...docker, APP_TLS_CERT_FILE: 'test-cert.pem' }), /Set both/);
    assert.throws(() => config({ ...docker, APP_TLS_KEY_FILE: 'test-key.pem' }), /Set both/);
});

test('native HTTP development remains available when HTTPS is not required', () => {
    const cfg = config({ APP_PUBLIC_URL: 'http://localhost:5173' });
    assert.equal(cfg.publicUrl, 'http://localhost:5173');
    assert.equal(cfg.port, 3100);
    assert.equal(config({ APP_PUBLIC_URL: 'http://localhost:5173', PORT: '3201' }).port, 3201);
});

test('HTTPS startup diagnostics expose a fixed configuration code without echoing the configured URL', () => {
    try {
        config({ ...docker, APP_PUBLIC_URL: 'http://user:private-value@localhost:3100' });
        assert.fail('Legacy HTTP configuration must fail');
    } catch (error) {
        assert.deepEqual(failureDetails(error), { category: 'configuration', configurationCode: 'https_public_url_required' });
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('private-value'), false);
    }
});

test('HTTPS configuration retains optional legacy secrets and explicit storage settings', () => {
    const cfg = config(docker);
    assert.equal(cfg.sessionSecret, '');
    assert.equal(cfg.oauth.encryptionKey, '');
    assert.equal(cfg.emailEnabled, false);
    assert.equal(cfg.databaseUrl, 'postgres://localhost/efactura_test');
    assert.throws(() => appConfig(docker), /DATABASE_URL/);
    assert.throws(() => appConfig({ ...docker, DATABASE_URL: 'postgres://localhost/efactura_test' }), /DATA_DIR/);
});
