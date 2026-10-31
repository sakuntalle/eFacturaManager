import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppSecrets } from '../app/secrets.js';
import { initializedConfig } from '../app/config.js';

test('concurrent web and worker startup share persistent secrets and preserve sessions after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'efactura-secrets-'));
    try {
        const env = { DATABASE_URL: 'postgres://localhost/test', DATA_DIR: directory,
            APP_PUBLIC_URL: 'https://localhost:8765', APP_SECRETS_DIR: directory };
        const configurations = await Promise.all(Array.from({ length: 12 }, () => initializedConfig(env)));
        assert.equal(configurations.every(cfg => cfg.sessionSecret === configurations[0].sessionSecret), true);
        assert.equal(configurations.every(cfg => cfg.oauth.encryptionKey === configurations[0].oauth.encryptionKey), true);
        assert.equal(Buffer.from(configurations[0].oauth.encryptionKey, 'base64').length, 32);
        const restarted = await initializedConfig(env);
        assert.equal(restarted.sessionSecret === configurations[0].sessionSecret, true);
        assert.equal(restarted.oauth.encryptionKey === configurations[0].oauth.encryptionKey, true);
        if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'secrets.json'))).mode & 0o077, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy encryption and session keys migrate once and are never replaced by later environment values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'efactura-secrets-'));
    try {
        const legacy = { sessionSecret: 'test-legacy-session-secret-with-32-characters',
            tokenEncryptionKey: Buffer.alloc(32, 7).toString('base64') };
        const initial = await loadAppSecrets(directory, legacy);
        assert.equal(initial.sessionSecret === legacy.sessionSecret, true);
        assert.equal(initial.tokenEncryptionKey === legacy.tokenEncryptionKey, true);
        const restarted = await loadAppSecrets(directory, { sessionSecret: 'other-test-secret-with-32-characters',
            tokenEncryptionKey: Buffer.alloc(32, 8).toString('base64') });
        assert.equal(restarted.sessionSecret === initial.sessionSecret, true);
        assert.equal(restarted.tokenEncryptionKey === initial.tokenEncryptionKey, true);
        const persisted = await readFile(join(directory, 'secrets.json'), 'utf8');
        await writeFile(join(directory, 'secrets.json'), '{invalid-private-data');
        await assert.rejects(loadAppSecrets(directory), error => error instanceof Error
            && error.message === 'Application secrets could not be read. Restore the private secrets backup.');
        assert.equal((await readFile(join(directory, 'secrets.json'), 'utf8')).includes('invalid-private-data'), true);
        await writeFile(join(directory, 'secrets.json'), persisted);
        await assert.rejects(loadAppSecrets(join(directory, 'invalid'), { tokenEncryptionKey: 'invalid' }), /secrets are invalid/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
