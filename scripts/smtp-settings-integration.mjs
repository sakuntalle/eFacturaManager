import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { initializedConfig } from '../app/config.ts';
import { PostgresRepository } from '../app/adapters/postgres.ts';
import { publicSmtp, smtpInput } from '../app/smtp-settings.ts';

const source = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('SMTP integration requires local PostgreSQL.');
const name = `efactura_smtp_${randomBytes(6).toString('hex')}`;
const target = new URL(source);
target.pathname = `/${name}`;
const directory = await mkdtemp(join(tmpdir(), 'efactura-smtp-'));
const admin = new pg.Client({ connectionString: source.toString() });
let repo;
let worker;
let created = false;
try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const env = { DATABASE_URL: target.toString(), APP_DATABASE_NAME: name, DATA_DIR: directory,
        APP_SECRETS_DIR: directory, APP_PUBLIC_URL: 'https://localhost:8765' };
    repo = new PostgresRepository(await initializedConfig(env));
    await repo.initialize();
    assert.equal((await repo.smtpSettings()).configured, false);
    const fixture = { host: 'smtp.example.test', port: 587, secure: false, requireTLS: true,
        user: 'synthetic-user', password: 'synthetic-password', from: 'sender@example.test' };
    await repo.saveSmtpSettings(smtpInput(fixture));
    const query = new pg.Client({ connectionString: target.toString() });
    await query.connect();
    try {
        const { rows: [row] } = await query.query('SELECT encrypted FROM workspace_smtp');
        assert.equal(row.encrypted.includes(fixture.password), false);
        assert.equal(row.encrypted.includes(fixture.user), false);
    } finally { await query.end(); }
    worker = new PostgresRepository(await initializedConfig(env));
    assert.equal((await worker.smtpSettings()).password === fixture.password, true);
    await worker.saveSmtpSettings(smtpInput({ ...fixture, port: 465, secure: true, password: '' }));
    const saved = await repo.smtpSettings();
    assert.equal(saved.port, 465);
    assert.equal(saved.password === fixture.password, true);
    assert.equal('password' in publicSmtp(saved), false);
    await repo.initialize();
    assert.equal((await repo.smtpSettings()).password === fixture.password, true);
    console.log('PASS: encrypted SMTP persistence, shared web/worker secrets, restart and password retention.');
} finally {
    await Promise.all([repo?.close(), worker?.close()]);
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
}
