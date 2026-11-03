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
let migrationWeb;
let migrationWorker;
let created = false;
let stage = 'setup';
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
    const connection = await repo.createManagedConnection('Migration test connection');
    const company = (name, cif, emailTo, emailEnabled) => ({ name, cif, kind: 'company', emailTo, emailEnabled, pollSeconds: 60 });
    const entities = await Promise.all([
        repo.createCompany(company('First company', '12345678', 'first@example.test', true), connection.id),
        repo.createCompany(company('Second company', '87654321', 'second@example.test', false), connection.id),
    ]);
    const legacyEnv = { ...env, SMTP_HOST: fixture.host, SMTP_PORT: String(fixture.port), SMTP_SECURE: 'false',
        SMTP_REQUIRE_TLS: 'true', SMTP_USER: fixture.user, SMTP_PASSWORD: fixture.password, EMAIL_FROM: fixture.from };
    migrationWeb = new PostgresRepository(await initializedConfig(legacyEnv));
    migrationWorker = new PostgresRepository(await initializedConfig(legacyEnv));
    stage = 'legacy_migration';
    await Promise.all([migrationWeb.initialize(), migrationWorker.initialize()]);
    assert.equal((await repo.smtpSettings()).configured, true, 'A legacy sender is restored for every entity');
    assert.equal((await repo.smtpSettings()).password === fixture.password, true);
    for (const entity of entities) assert.deepEqual(await repo.findCompany(entity.id), entity,
        'Migration preserves entity notification recipients and switches');
    const query = new pg.Client({ connectionString: target.toString() });
    await query.connect();
    try {
        const { rows: [row] } = await query.query('SELECT encrypted FROM workspace_smtp');
        assert.equal(row.encrypted.includes(fixture.password), false);
        assert.equal(row.encrypted.includes(fixture.user), false);
        assert.equal((await query.query('SELECT count(*)::integer AS total FROM workspace_smtp')).rows[0].total, 1);
    } finally { await query.end(); }
    worker = new PostgresRepository(await initializedConfig(env));
    stage = 'password_retention';
    assert.equal((await worker.smtpSettings()).password === fixture.password, true);
    await worker.saveSmtpSettings(smtpInput({ ...fixture, port: 465, secure: true, password: '' }));
    const saved = await repo.smtpSettings();
    assert.equal(saved.port, 465);
    assert.equal(saved.password === fixture.password, true);
    assert.equal('password' in publicSmtp(saved), false);
    await migrationWeb.initialize();
    assert.equal((await repo.smtpSettings()).port, 465, 'An older .env sender cannot overwrite in-app changes');
    assert.equal((await repo.smtpSettings()).password === fixture.password, true);
    console.log('PASS: legacy SMTP migration, encrypted persistence, concurrent startup, entity isolation and password retention.');
} catch (error) {
    const code = typeof error?.code === 'string' && /^(?:[0-9A-Z]{5}|ERR_ASSERTION)$/.test(error.code) ? error.code : 'unexpected';
    const kind = ['AssertionError', 'TypeError', 'Error'].includes(error?.name) ? error.name : 'unexpected';
    console.error(JSON.stringify({ category: 'smtp_migration_test_failure', stage, kind, code }));
    process.exitCode = 1;
} finally {
    await Promise.all([repo?.close(), worker?.close(), migrationWeb?.close(), migrationWorker?.close()]);
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
}
