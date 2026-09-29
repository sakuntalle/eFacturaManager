import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { config } from '../app/config.ts';
import { PostgresRepository } from '../app/adapters/postgres.ts';
import { passwordHash, verifyPassword } from '../app/admin-auth.ts';
import { PasswordResets } from '../app/password-reset.ts';
import { Sessions } from '../app/sessions.ts';

const source = new URL(process.env.DATABASE_URL);
const name = `efactura_reset_${randomBytes(6).toString('hex')}`;
const url = new URL(source);
url.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: source.toString() });
await admin.connect();
let repo;
let query;
try {
    await admin.query(`CREATE DATABASE ${name}`);
    const cfg = config({ ...process.env, DATABASE_URL: url.toString(), APP_DATABASE_NAME: name,
        ANAF_MODE: 'mock', ANAF_CIF: '12345678', APP_PUBLIC_URL: 'https://localhost:8765' });
    repo = new PostgresRepository(cfg);
    await repo.initialize();
    const originalPassword = 'original-admin-password';
    assert.equal(await repo.createAdmin(passwordHash(originalPassword)), true);
    const connection = await repo.createManagedConnection('Recovery test connection');
    const company = await repo.createCompany({ name: 'Recovery test company', kind: 'company', cif: '12345678',
        emailTo: 'owner@example.test', emailEnabled: false, pollSeconds: 60 }, connection.id);
    const sent = [];
    const resets = new PasswordResets(repo, { sendPasswordReset: async (to, link) => sent.push({ to, link }) },
        cfg.publicUrl);
    const sessions = new Sessions(repo, cfg);
    const session = await sessions.create(false);
    const cookie = `efactura_session=${session.token}`;
    await resets.request('stranger@example.test');
    assert.equal(sent.length, 0, 'An unknown address must never receive a reset link');
    assert.equal(await sessions.valid(cookie), true);
    await resets.request('OWNER@example.test');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@example.test', 'Send only to the saved address');
    const token = new URL(sent[0].link).searchParams.get('reset');
    assert.equal(new URL(sent[0].link).origin, cfg.publicUrl);
    query = new pg.Client({ connectionString: url.toString() });
    await query.connect();
    const stored = await query.query('SELECT token_hash FROM admin_password_resets');
    assert.equal(stored.rowCount, 1);
    assert.notEqual(stored.rows[0].token_hash, token, 'Only a token hash may be stored');
    assert.equal(await resets.complete('invalid', passwordHash('different-secure-password')), false);
    await query.query("UPDATE admin_password_resets SET expires_at=now()-interval '1 second'");
    assert.equal(await resets.complete(token, passwordHash('different-secure-password')), false,
        'Expired links cannot reset the password');
    assert.equal(verifyPassword(originalPassword, (await repo.adminAccount()).passwordHash), true);
    await resets.request('owner@example.test');
    const validToken = new URL(sent[1].link).searchParams.get('reset');
    const nextPassword = 'different-secure-password';
    assert.equal(await resets.complete(validToken, passwordHash(nextPassword)), true);
    assert.equal(await resets.complete(validToken, passwordHash('another-secure-password')), false,
        'A reset link is single-use');
    assert.equal(verifyPassword(nextPassword, (await repo.adminAccount()).passwordHash), true);
    assert.equal(await sessions.valid(cookie), false, 'Password recovery revokes existing sessions');
    await resets.request('owner@example.test');
    const revokedToken = new URL(sent[2].link).searchParams.get('reset');
    const currentHash = (await repo.adminAccount()).passwordHash;
    assert.equal(await repo.changeAdminPassword(currentHash, passwordHash('changed-with-current-password')), true);
    assert.equal(await resets.complete(revokedToken, passwordHash('another-secure-password')), false,
        'Changing the password normally revokes pending reset links');
    await resets.request('owner@example.test');
    const removedEmailToken = new URL(sent[3].link).searchParams.get('reset');
    await repo.deleteCompany(company.id);
    assert.equal(await resets.complete(removedEmailToken, passwordHash('another-secure-password')), false,
        'Removing the only matching entity revokes recovery eligibility');
    console.log('PASS: registered-email recovery, no unknown-email delivery, expiry, replay protection and session revocation.');
} finally {
    if (query) await query.end();
    if (repo) await repo.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
}
