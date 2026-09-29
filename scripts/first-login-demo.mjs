import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const directory = '.local/first-login-demo';
const stateFile = join(directory, 'state.json');
const port = 3201;
const origin = `http://localhost:${port}`;
const prefix = 'efactura_first_login_';

async function state() {
    try {
        return JSON.parse(await readFile(stateFile, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function databaseAdmin() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Load your local .env file.');
    const source = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(source.hostname)) {
        throw new Error('The first-login test requires a local PostgreSQL server.');
    }
    const client = new pg.Client({ connectionString: source.toString() });
    await client.connect();
    return { source, client };
}

function isolatedEnvironment(source, databaseName) {
    const database = new URL(source);
    database.pathname = `/${databaseName}`;
    return {
        ...process.env,
        DATABASE_URL: database.toString(),
        ADMIN_BOOTSTRAP_DIR: join(directory, 'admin'),
        ANAF_MODE: 'mock',
        ANAF_CIF: '12345678',
        ANAF_MOCK_URL: 'http://127.0.0.1:8790',
        APP_PUBLIC_URL: origin,
        APP_SESSION_SECRET: randomBytes(32).toString('hex'),
        PORT: String(port),
        APP_TLS_CERT_FILE: '',
        APP_TLS_KEY_FILE: '',
        EMAIL_ENABLED: 'false',
        DATA_DIR: join(directory, 'data'),
    };
}

async function healthy() {
    try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function start() {
    if (await state()) throw new Error('Test instance already exists. Run npm run first-login:stop before starting a fresh one.');
    if (await healthy()) throw new Error(`Port ${port} is already serving an application.`);
    const { source, client } = await databaseAdmin();
    const databaseName = `${prefix}${randomBytes(6).toString('hex')}`;
    let child;
    let created = false;
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await client.query(`CREATE DATABASE ${databaseName}`);
        created = true;
        const env = isolatedEnvironment(source, databaseName);
        const bootstrap = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-admin.mjs'],
            { env, encoding: 'utf8' });
        if (bootstrap.status !== 0) throw new Error('Administrator bootstrap failed.');
        const log = await open(join(directory, 'server.log'), 'w', 0o600);
        try {
            child = spawn(process.execPath, ['dist/server/app/api.js'], {
                env, detached: true, stdio: ['ignore', log.fd, log.fd],
            });
            child.unref();
        } finally {
            await log.close();
        }
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await healthy()) { ready = true; break; }
            if (child.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error('Test instance did not become healthy.');
        await writeFile(stateFile, JSON.stringify({ databaseName, pid: child.pid, port }, null, 4),
            { mode: 0o600, flag: 'wx' });
        console.log(`First-login test instance is ready at ${origin}`);
        console.log(`Username: admin. Read the temporary password in ${join(directory, 'admin', 'README.md')}`);
        console.log('The live database and website were not changed.');
    } catch (error) {
        if (child?.pid) process.kill(child.pid, 'SIGTERM');
        if (created) await client.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
        await rm(directory, { recursive: true, force: true });
        throw error;
    } finally {
        await client.end();
    }
}

async function stop() {
    const current = await state();
    if (!current) { console.log('No first-login test instance is recorded.'); return; }
    if (!new RegExp(`^${prefix}[0-9a-f]{12}$`).test(current.databaseName)) {
        throw new Error('Invalid test database name; refusing to remove it.');
    }
    const { client } = await databaseAdmin();
    try {
        try { process.kill(current.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await client.query(`DROP DATABASE ${current.databaseName} WITH (FORCE)`);
        await rm(directory, { recursive: true, force: true });
        console.log('First-login test instance and its temporary database were removed.');
    } finally {
        await client.end();
    }
}

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'stop') await stop();
else throw new Error('Use start or stop.');
