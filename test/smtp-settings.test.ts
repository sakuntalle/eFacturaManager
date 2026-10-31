import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { config } from './helpers/config.js';
import { PostgresRepository } from '../app/adapters/postgres.js';
import { defaultSmtpSettings, publicSmtp, smtpInput } from '../app/smtp-settings.js';
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
