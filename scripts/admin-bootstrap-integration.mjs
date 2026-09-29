import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../app/config.ts';
import { PostgresRepository } from '../app/adapters/postgres.ts';
import { verifyPassword } from '../app/admin-auth.ts';

const sourceUrl = new URL(process.env.DATABASE_URL);
const databaseName = `efactura_admin_${randomBytes(6).toString('hex')}`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
const directory = await mkdtemp(join(tmpdir(), 'efactura-admin-'));
const admin = new pg.Client({ connectionString: sourceUrl.toString() });
await admin.connect();
let repo;
try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const environment = { ...process.env, DATABASE_URL: testUrl.toString(), APP_DATABASE_NAME: databaseName,
        ADMIN_BOOTSTRAP_DIR: join(directory, 'admin'), ANAF_MODE: 'mock', ANAF_CIF: '12345678' };
    const bootstrap = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-admin.mjs'],
        { env: environment, encoding: 'utf8' });
    const first = bootstrap();
    assert.equal(first.status, 0, 'Bootstrap must succeed on a new database');
    const file = join(directory, 'admin', 'README.md');
    const readme = await readFile(file, 'utf8');
    const password = readme.match(/Temporary password: ([A-Za-z0-9_-]{12})/)?.[1];
    assert.ok(password, 'Local README contains the generated initial password');
    assert.equal(first.stdout.includes(password), false, 'Bootstrap logs must not print the password');
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0);
    repo = new PostgresRepository(config(environment));
    const account = await repo.adminAccount();
    assert.equal(account.mustChangePassword, true);
    assert.equal(verifyPassword(password, account.passwordHash), true);
    const second = bootstrap();
    assert.equal(second.status, 0, 'Bootstrap may safely be rerun');
    assert.equal(await readFile(file, 'utf8'), readme, 'Rerunning must retain the original password');
    assert.deepEqual(await repo.companies(), [], 'A fresh workspace must have no entities');
    assert.deepEqual(await repo.managedConnections(), [], 'A fresh workspace must have no ANAF connections');
    await repo.initialize();
    assert.deepEqual(await repo.companies(), [], 'Restart must not create a dummy entity');
    assert.deepEqual(await repo.managedConnections(), [], 'Restart must not create a simulated connection');
    const connection = await repo.createManagedConnection('First authorization');
    const company = await repo.createCompany({ name: 'Test company', kind: 'company', cif: '12345678',
        emailTo: 'test@example.org', emailEnabled: false, pollSeconds: 60 }, connection.id);
    assert.equal(company.connectionId, connection.id);
    assert.deepEqual((await repo.managedConnections())[0].entityIds, [company.id]);
    console.log('PASS: first login starts empty, then accepts an explicit connection and entity.');
} finally {
    await repo?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
}
