import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolve only synthetic configuration; never load the checkout's private .env.
const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    POSTGRES_PASSWORD: 'synthetic-compose-password',
    APP_TLS_PORT: '9876',
    EFACTURA_VERSION: '1.0.1',
};
const composeAvailable = spawnSync('docker', ['compose', 'version'], { env: environment }).status === 0;

test('source and release Compose retain HTTPS and shared secrets without release builds',
    { skip: !composeAvailable }, () => {
        const root = mkdtempSync(join(tmpdir(), 'efactura-compose-'));
        try {
            writeFileSync(join(root, 'empty.env'), '');
            for (const name of ['compose.yaml', 'compose.release.yaml']) {
                copyFileSync(new URL(`../${name}`, import.meta.url), join(root, name));
            }
            for (const name of ['compose.yaml', 'compose.release.yaml']) {
                const result = spawnSync('docker', ['compose', '--env-file', join(root, 'empty.env'),
                    '-f', join(root, name), '--profile', 'tools', 'config', '--format', 'json'],
                { env: environment, encoding: 'utf8' });
                assert.equal(result.status, 0, `${name} must resolve successfully`);
                const resolved = JSON.parse(result.stdout);
                assert.equal(resolved.name, 'efactura-manager');
                assert.deepEqual(Object.keys(resolved.services).sort(), ['admin-bootstrap', 'database', 'web', 'worker']);
                const web = resolved.services.web;
                assert.equal(web.ports.length, 1);
                assert.equal(web.ports[0].host_ip, '127.0.0.1');
                assert.equal(web.ports[0].target, 9876);
                assert.equal(web.ports[0].published, '9876');
                assert.equal(web.environment.APP_REQUIRE_HTTPS, 'true');
                assert.equal(web.environment.APP_TLS_PORT, '9876');
                assert.match(web.healthcheck.test.join(' '), /https:\/\/127\.0\.0\.1:/);
                assert.ok(web.volumes.some((volume: { target: string; read_only?: boolean }) =>
                    volume.target === '/app/tls' && volume.read_only));
                for (const service of ['web', 'worker', 'admin-bootstrap']) {
                    const item = resolved.services[service];
                    assert.equal(item.environment.APP_SECRETS_DIR, '/app/secrets');
                    assert.ok(item.volumes.some((volume: { source: string; target: string }) =>
                        volume.source === 'app-secrets' && volume.target === '/app/secrets'));
                    if (name === 'compose.release.yaml') {
                        assert.equal(item.build, undefined);
                        assert.equal(item.image, 'ghcr.io/sakuntalle/efactura-manager:1.0.1');
                    } else {
                        assert.ok(item.build);
                    }
                }
                assert.equal(resolved.volumes.database.name, 'efactura-manager_database');
                assert.equal(resolved.volumes['app-secrets'].name, 'efactura-manager_app-secrets');
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
