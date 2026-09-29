import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import pg from 'pg';
import { FIRST_LOGIN_HTTP_PORT, FIRST_LOGIN_HTTPS_PORT, FIRST_LOGIN_LIVE_ORIGIN,
    FIRST_LOGIN_MOCK_ORIGIN, isolatedEnvironment } from './first-login-environment.mjs';

const directory = '.local/first-login-demo';
const stateFile = join(directory, 'state.json');
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

async function healthy() {
    try {
        const response = await fetch(`${FIRST_LOGIN_MOCK_ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function httpsHealthy(ca) {
    return new Promise(resolve => {
        const request = httpsRequest(`${FIRST_LOGIN_LIVE_ORIGIN}/api/health`, { ca }, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.setTimeout(1000, () => request.destroy());
        request.end();
    });
}

async function start(mode) {
    if (await state()) throw new Error('Test instance already exists. Run npm run first-login:stop before starting a fresh one.');
    if (await healthy()) throw new Error(`Port ${FIRST_LOGIN_HTTP_PORT} is already serving an application.`);
    if (mode === 'live' && (!process.env.ANAF_CLIENT_ID || !process.env.ANAF_CLIENT_SECRET
        || !process.env.ANAF_TOKEN_ENCRYPTION_KEY || !process.env.ANAF_CIF)) {
        throw new Error('Live ANAF OAuth configuration is incomplete in the local .env file.');
    }
    const ca = mode === 'live' ? await readFile(join(execFileSync('mkcert', ['-CAROOT'],
        { encoding: 'utf8' }).trim(), 'rootCA.pem')) : null;
    const { source, client } = await databaseAdmin();
    const databaseName = `${prefix}${randomBytes(6).toString('hex')}`;
    let child;
    let created = false;
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await client.query(`CREATE DATABASE ${databaseName}`);
        created = true;
        const env = isolatedEnvironment(source, databaseName, mode);
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
            if (await healthy() && (mode === 'mock' || await httpsHealthy(ca))) { ready = true; break; }
            if (child.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error('Test instance did not become healthy.');
        const origin = mode === 'live' ? FIRST_LOGIN_LIVE_ORIGIN : FIRST_LOGIN_MOCK_ORIGIN;
        await writeFile(stateFile, JSON.stringify({ databaseName, pid: child.pid, mode, origin }, null, 4),
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
if (command === 'start') await start('live');
else if (command === 'start-mock') await start('mock');
else if (command === 'stop') await stop();
else throw new Error('Use start, start-mock or stop.');
