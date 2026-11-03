import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { config } from './helpers/config.js';
import { PostgresRepository } from '../app/adapters/postgres.js';
import { defaultSmtpSettings, legacySmtpInput, publicSmtp, smtpInput } from '../app/smtp-settings.js';
import { SmtpNotificationChannel } from '../app/adapters/email.js';

const input = { host: 'smtp.example.test', port: 587, secure: false, requireTLS: true,
    user: 'test-user', password: 'synthetic-smtp-password', from: 'Invoices <sender@example.test>' };

test('unconfigured SMTP never attempts account recovery delivery to a default local server', async () => {
    const mailer = new SmtpNotificationChannel(config());
    await assert.rejects(mailer.sendPasswordReset('recipient@example.test', 'https://localhost:8765/'), /Configure SMTP/);
});

test('SMTP validation rejects invalid ports, addresses and injected headers with fixed messages', () => {
    for (const changed of [{ port: 0 }, { port: 65536 }, { port: '587' }, { secure: 'false' },
        { host: 'https://smtp.example.test' }, { host: 'smtp.example.test\r\nprivate-value' },
        { from: 'sender@example.test\nBcc: private-value' }, { password: 'private-value\n' }]) {
        assert.throws(() => smtpInput({ ...input, ...changed }), error => error instanceof Error
            && !error.message.includes('private-value'));
    }
    assert.equal(smtpInput(input).port, 587);
    assert.equal(publicSmtp(defaultSmtpSettings()).configured, false);
    assert.equal('password' in publicSmtp({ ...defaultSmtpSettings(), ...input }), false);
});

test('legacy SMTP import requires an explicit complete sender and never restores implicit local defaults', () => {
    const env = { SMTP_HOST: input.host, SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'true',
        SMTP_USER: input.user, SMTP_PASSWORD: input.password, EMAIL_FROM: input.from };
    assert.deepEqual(legacySmtpInput(env), input);
    assert.equal(legacySmtpInput({}), null);
    for (const changed of [{ SMTP_HOST: '' }, { EMAIL_FROM: '' }, { SMTP_PORT: 'invalid' },
        { SMTP_SECURE: 'invalid' }, { SMTP_REQUIRE_TLS: 'invalid' }, { SMTP_PASSWORD: '' },
        { SMTP_HOST: 'private\nvalue' }, { EMAIL_FROM: 'private\nvalue' }]) {
        assert.equal(legacySmtpInput({ ...env, ...changed }), null);
    }
    assert.equal(legacySmtpInput({ SMTP_HOST: 'relay.example.test', EMAIL_FROM: 'sender@example.test' })!.port, 1025,
        'A legacy sender retains the old port default');
    const cfg = config(env);
    assert.equal(cfg.smtp.configured, false, 'The legacy sender must be persisted before it becomes active');
    assert.deepEqual(cfg.legacySmtp, input);
});

test('initialization migrates legacy SMTP once into encrypted storage and preserves newer saved settings', async () => {
    let encrypted: string | undefined;
    let inserts = 0;
    const client = { query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT encrypted')) return { rows: encrypted ? [{ encrypted }] : [] };
        if (sql.startsWith('INSERT INTO workspace_smtp')) { encrypted = String(params![1]); inserts++; }
        return { rows: [], rowCount: 1 };
    }, release: () => {} };
    const pool = { query: client.query, connect: async () => client } as unknown as pg.Pool;
    const cfg = config({ ANAF_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        SMTP_HOST: input.host, SMTP_PORT: String(input.port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'true',
        SMTP_USER: input.user, SMTP_PASSWORD: input.password, EMAIL_FROM: input.from });
    const repo = new PostgresRepository(cfg, undefined, pool);
    await repo.initialize();
    assert.equal((await repo.smtpSettings()).configured, true);
    assert.equal((await repo.smtpSettings()).password === input.password, true);
    assert.equal(encrypted!.includes(input.password), false);
    assert.equal(encrypted!.includes(input.host), false);
    await repo.initialize();
    assert.equal(inserts, 1, 'Restarting cannot re-import the sender');
    await repo.saveSmtpSettings(smtpInput({ ...input, host: 'new.example.test', password: 'replacement-synthetic-password' }));
    const saved = encrypted;
    await new PostgresRepository(cfg, undefined, pool).initialize();
    assert.equal(encrypted, saved, 'Stale .env values cannot overwrite sender changes saved in the app');
    assert.equal((await repo.smtpSettings()).host, 'new.example.test');
});

test('SMTP storage encrypts credentials, survives restart, and retains a password omitted by the settings form', async () => {
    let encrypted: string | undefined;
    const client = { query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT encrypted')) return { rows: encrypted ? [{ encrypted }] : [] };
        if (sql.startsWith('INSERT INTO workspace_smtp')) encrypted = String(params![1]);
        return { rows: [] };
    }, release: () => {} };
    const pool = { query: client.query, connect: async () => client } as unknown as pg.Pool;
    const cfg = config({ ANAF_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') });
    const repo = new PostgresRepository(cfg, undefined, pool);
    assert.equal((await repo.smtpSettings()).configured, false);
    await repo.saveSmtpSettings(smtpInput(input));
    assert.equal(encrypted!.includes(input.password), false);
    assert.equal(encrypted!.includes(input.user), false);
    const restarted = new PostgresRepository(cfg, undefined, pool);
    assert.equal((await restarted.smtpSettings()).password === input.password, true);
    await restarted.saveSmtpSettings(smtpInput({ ...input, password: '', port: 465, secure: true }));
    const saved = await repo.smtpSettings();
    assert.equal(saved.port, 465);
    assert.equal(saved.password === input.password, true);
    const visible = publicSmtp(saved);
    assert.equal(visible.configured, true);
    assert.equal(visible.hasPassword, true);
    assert.equal(JSON.stringify(visible).includes(input.password), false);
    const wrongKey = new PostgresRepository({ ...cfg, oauth: { ...cfg.oauth,
        encryptionKey: Buffer.alloc(32, 4).toString('base64') } }, undefined, pool);
    await assert.rejects(wrongKey.smtpSettings(), /Restore the application secrets backup/);
});
