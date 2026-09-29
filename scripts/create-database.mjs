import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { selectedDatabaseUrl } from '../app/database-selection.ts';

const name = process.argv[2];
if (!name) throw new Error('Usage: npm run db:create -- <database_name>');
const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is required in .env.');
const targetUrl = selectedDatabaseUrl(source, name);
const serverUrl = new URL(source);
if (!['localhost', '127.0.0.1'].includes(serverUrl.hostname)) {
    throw new Error('This command only creates databases on the local PostgreSQL server.');
}
if (new URL(source).pathname === new URL(targetUrl).pathname) {
    throw new Error('The selected database already matches DATABASE_URL.');
}
serverUrl.pathname = '/postgres';

const client = new pg.Client({ connectionString: serverUrl.toString() });
try {
    await client.connect();
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount) throw new Error(`Database ${name} already exists; no changes were made.`);
    await client.query(`CREATE DATABASE "${name}"`);
} catch (error) {
    if (error instanceof Error && error.message.startsWith(`Database ${name} already exists`)) throw error;
    throw new Error('Could not create the local database. Check that PostgreSQL is running and the database user can create databases.');
} finally {
    await client.end().catch(() => {});
}

const bootstrap = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/bootstrap-admin.mjs'], {
    env: {
        ...process.env,
        DATABASE_URL: targetUrl,
        APP_DATABASE_NAME: name,
        ADMIN_BOOTSTRAP_DIR: `.local/admin/${name}`,
    },
    encoding: 'utf8',
});
if (bootstrap.status !== 0) {
    throw new Error(`Database ${name} was created, but administrator setup failed. Resolve the setup error before selecting it.`);
}
console.log(`Database ${name} is ready. The temporary admin password is in .local/admin/${name}/README.md`);
console.log(`Set APP_DATABASE_NAME=${name} in .env, then recreate the web and worker containers.`);
