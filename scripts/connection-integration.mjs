import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest, createServer } from 'node:https';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';
import { config } from '../dist/server/app/config.js';
import { PostgresRepository } from '../dist/server/app/adapters/postgres.js';
import { DEFAULT_CONNECTION_ID, WORKSPACE_ID } from '../dist/server/app/adapters/postgres.js';
import { Sessions } from '../dist/server/app/sessions.js';
import { connectionFailureMessage } from '../dist/server/app/connection-errors.js';
import { AnafConnection } from '../dist/server/app/connection.js';
import { passwordHash } from '../dist/server/app/admin-auth.js';

const origin = 'https://localhost:9876';
const ca = await readFile(join(execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim(), 'rootCA.pem'));
const sourceUrl = new URL('postgres://efactura:local-development@127.0.0.1:55432/efactura');
const databaseName = `efactura_connection_${randomBytes(6).toString('hex')}`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
const databaseAdmin = new pg.Client({ connectionString: sourceUrl.toString() });
await databaseAdmin.connect();
await databaseAdmin.query(`CREATE DATABASE ${databaseName}`);
const env = { ...process.env, ANAF_MODE: 'live', ANAF_ENV: 'test', ANAF_CIF: '9999999999876',
    APP_PUBLIC_URL: origin, PORT: '3199', APP_TLS_PORT: '9876', APP_TLS_CERT_FILE: '.local/tls/localhost.pem',
    APP_TLS_KEY_FILE: '.local/tls/localhost-key.pem', ANAF_CLIENT_ID: 'integration-private-id',
    ANAF_CLIENT_SECRET: 'integration-private-secret', ANAF_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ANAF_REDIRECT_URI: `${origin}/callback`, EMAIL_ENABLED: 'false',
    DATABASE_URL: testUrl.toString(), APP_DATABASE_NAME: databaseName };
const cfg = config(env);
const repo = new PostgresRepository(cfg);
await repo.initialize();
const setup = new pg.Client({ connectionString: env.DATABASE_URL });
await setup.connect();
try {
    await setup.query(`INSERT INTO managed_connections(id,workspace_id,mode,environment,name,data)
        VALUES ($1,$2,$3,$4,$5,$6)`, [DEFAULT_CONNECTION_ID, WORKSPACE_ID, 'live', 'test',
        'Primary ANAF connection', { state: 'disconnected', encrypted: null, fingerprint: '', connectedAt: null }]);
} finally { await setup.end(); }
const firstCompany = await repo.createCompany({ name: 'Test company', kind: 'company', cif: env.ANAF_CIF,
    emailTo: 'test@example.org', emailEnabled: false, pollSeconds: 60 }, DEFAULT_CONNECTION_ID);
const initialPassword = 'integration-initial-password';
const changedPassword = 'integration-changed-password';
const child = spawn(process.execPath, ['--import', './test/helpers/oauth-fetch.mjs', 'dist/server/app/api.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', value => { logs += value; });
child.stderr.on('data', value => { logs += value; });
const exited = new Promise(resolve => child.once('exit', resolve));
const otherRepo = new PostgresRepository(cfg);
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
function request(path, { method = 'GET', cookie = '', body, requestOrigin = origin } = {}) {
    return new Promise((resolve, reject) => {
        const req = httpsRequest(`${origin}${path}`, { ca, family: 4, method, headers: {
            Origin: requestOrigin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}),
        } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Local test timed out.')));
        req.end(body ? JSON.stringify(body) : undefined);
    });
}
const providerOrigin = 'https://127.0.0.1:9877';
let providerError = false;
const provider = createServer({ cert: await readFile('.local/tls/localhost.pem'), key: await readFile('.local/tls/localhost-key.pem') }, (req, res) => {
    const state = new URL(req.url, providerOrigin).searchParams.get('state');
    const result = providerError ? 'error=access_denied&error_description=private-test-provider-detail' : 'code=valid';
    res.writeHead(302, { Location: `${origin}/callback?${result}&state=${state}` }).end();
});
const cookie = response => response.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') ?? '';
try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
        if (await request('/api/health').then(r => r.status === 200).catch(() => false)) { ready = true; break; }
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Test app must start');
    assert.equal(await repo.createAdmin(passwordHash(initialPassword)), true);
    const initialLogin = await request('/api/login', { method: 'POST', body: { username: 'admin', password: initialPassword } });
    assert.equal(initialLogin.status, 201);
    assert.equal((await request('/api/status', { cookie: cookie(initialLogin) })).status, 403,
        'Initial password must not grant workspace access');
    assert.equal(JSON.parse((await request('/api/session', { cookie: cookie(initialLogin) })).text).mustChangePassword, true);
    await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(9877, '127.0.0.1', resolve); });
    // A real browser form is essential: manually supplied Origin headers hide
    // navigation behavior caused by the page's Referrer-Policy.
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
    try {
        // Only this isolated synthetic-credential browser context bypasses OS trust.
        // The HTTPS requests above/below still validate against the local CA.
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        page.setDefaultTimeout(10000);
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
            if (url.pathname === '/api/anaf/connect' || /^\/api\/anaf\/connections\/[^/]+\/connect$/.test(url.pathname)) {
                // Inspect the real backend response without following it to ANAF.
                // Substitute a local HTTPS provider to exercise actual cross-site redirects/cookies.
                const response = await route.fetch({ maxRedirects: 0 });
                if (response.status() !== 303) return route.fulfill({ response });
                const authorization = new URL(response.headers().location);
                assert.equal(authorization.hostname, 'logincert.anaf.ro');
                assert.equal(authorization.searchParams.has('client_secret'), false);
                return route.fulfill({ response, headers: { ...response.headers(),
                    location: `${providerOrigin}/authorize?state=${authorization.searchParams.get('state')}` } });
            }
            return route.continue();
        });
        await page.goto(origin);
        await page.getByLabel('Username', { exact: true }).fill('admin');
        await page.getByLabel('Password', { exact: true }).fill(initialPassword);
        await page.getByRole('button', { name: /Sign in/ }).click();
        await page.getByRole('heading', { name: 'Change your temporary password' }).waitFor();
        await page.getByLabel('Current password').fill(initialPassword);
        await page.getByLabel('New password', { exact: true }).fill(changedPassword);
        await page.getByLabel('Confirm new password').fill(changedPassword);
        await page.getByRole('button', { name: 'Change password' }).click();
        await page.getByRole('heading', { name: 'Manage ANAF connections' }).waitFor();
        await page.getByRole('button', { name: 'Manage ANAF connections' }).first().click();
        const outgoing = page.waitForResponse(response => /\/api\/anaf\/connections\/[^/]+\/connect$/.test(new URL(response.url()).pathname));
        const firstReturn = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/status'
            && response.status() === 200 && (await response.json()).connection.state === 'connected');
        firstReturn.catch(() => {});
        outgoing.catch(() => {});
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        const connected = await outgoing;
        assert.equal(connected.request().headers().origin, origin, 'Browser form must retain its same-origin Origin');
        assert.equal(connected.status(), 303, 'Connect must redirect to authorization');
        const destination = new URL(connected.headers().location);
        assert.equal(destination.origin, providerOrigin);
        assert.equal(destination.searchParams.has('client_secret'), false);
        await firstReturn;
        await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm disconnect' }).click();
        await page.getByRole('button', { name: 'Connect', exact: true }).waitFor();
        providerError = true;
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await page.getByText(connectionFailureMessage('provider_access_denied'), { exact: true }).waitFor();
        assert.equal((await page.locator('body').innerText()).includes('private-test-provider-detail'), false);
        assert.equal(new URL(page.url()).searchParams.has('reason'), false);
        providerError = false;
        const secondReturn = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/status'
            && response.status() === 200 && (await response.json()).connection.state === 'connected');
        secondReturn.catch(() => {});
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await secondReturn;
        await page.getByText('Connected', { exact: true }).waitFor();
        await page.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    } finally { await browser.close(); }
    const login = await request('/api/login', { method: 'POST', body: { username: 'admin', password: changedPassword } });
    assert.equal(login.status, 201);
    assert.match(login.headers['set-cookie'][0], /Secure/);
    assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
    const session = cookie(login);
    const added = await request('/api/connections', { method: 'POST', cookie: session,
        body: { name: 'New ANAF certificate' } });
    assert.equal(added.status, 201);
    const secondConnectionId = JSON.parse(added.text).id;
    const entity = await request('/api/companies', { method: 'POST', cookie: session,
        body: { name: 'Second company', kind: 'company', cif: '87654321', emailTo: 'second@example.test',
            emailEnabled: true, pollSeconds: 60, connectionId: secondConnectionId } });
    assert.equal(entity.status, 201);
    const secondCompanyId = JSON.parse(entity.text).id;
    assert.equal(JSON.parse(entity.text).connectionId, secondConnectionId);
    const beforeSecond = JSON.parse((await request(`/api/status?companyId=${secondCompanyId}`, { cookie: session })).text);
    assert.equal(beforeSecond.connection.state, 'disconnected');
    assert.equal(beforeSecond.connections.find(item => item.id === secondConnectionId).verificationCif, '87654321');
    assert.equal(JSON.parse((await request(`/api/status?companyId=${firstCompany.id}`, { cookie: session })).text).connection.state, 'connected');
    const secondStart = await request(`/api/anaf/connections/${secondConnectionId}/connect`, { method: 'POST', cookie: session });
    assert.equal(secondStart.status, 303);
    const secondState = new URL(secondStart.headers.location).searchParams.get('state');
    const secondReturn = await request(`/callback?code=valid&state=${secondState}`, { cookie: cookie(secondStart) });
    assert.equal(secondReturn.headers.location, `/?view=connections&anaf=connected&connection=${secondConnectionId}`);
    assert.equal(JSON.parse((await request(`/api/status?companyId=${secondCompanyId}`, { cookie: session })).text).connection.state, 'connected');
    assert.equal((await request(`/api/sync?companyId=${secondCompanyId}`,
        { method: 'POST', cookie: session })).status, 201);
    assert.equal(JSON.parse((await request(`/api/status?companyId=${firstCompany.id}`, { cookie: session })).text).connection.state, 'connected',
        'Authorizing another certificate must not replace the primary connection');
    assert.equal((await request(`/api/anaf/connections/${secondConnectionId}/disconnect`,
        { method: 'POST', cookie: session })).status, 201);
    assert.equal((await request(`/api/sync?companyId=${secondCompanyId}`,
        { method: 'POST', cookie: session })).status, 400);
    assert.equal((await request(`/api/sync?companyId=${firstCompany.id}`, { method: 'POST', cookie: session })).status, 201);
    assert.equal(JSON.parse((await request(`/api/status?companyId=${firstCompany.id}`, { cookie: session })).text).connection.state, 'connected',
        'Disconnecting the second connection must not interrupt the primary one');
    assert.equal((await request('/api/anaf/connect', { method: 'POST' })).status, 401);
    for (const requestOrigin of ['null', 'https://untrusted.example']) {
        assert.equal((await request('/api/anaf/connect', { method: 'POST', cookie: session, requestOrigin })).status, 403);
    }
    const begin = async () => {
        const response = await request('/api/anaf/connect', { method: 'POST', cookie: session });
        assert.equal(response.status, 303);
        assert.match(response.headers['set-cookie'][0], /SameSite=Lax/);
        assert.equal(response.text.includes(env.ANAF_CLIENT_ID), false);
        const location = new URL(response.headers.location);
        assert.equal(location.searchParams.get('redirect_uri'), `${origin}/callback`);
        assert.equal(location.searchParams.has('client_secret'), false);
        return { binding: cookie(response), callback: `/callback?code=valid&state=${location.searchParams.get('state')}` };
    };
    const start = await begin();
    assert.equal((await request(start.callback)).headers.location, '/?view=connections&anaf=failed&reason=invalid_return');
    const completed = await request(start.callback, { cookie: start.binding });
    assert.equal(completed.headers.location, `/?view=connections&anaf=connected&connection=${DEFAULT_CONNECTION_ID}`);
    assert.equal(completed.headers['referrer-policy'], 'no-referrer');
    assert.equal((await request(start.callback, { cookie: start.binding })).headers.location, '/?view=connections&anaf=failed&reason=attempt_missing');
    let status = await request(`/api/status?companyId=${firstCompany.id}`, { cookie: session });
    assert.equal(JSON.parse(status.text).connection.state, 'connected');
    const row = await repo.connection();
    const forbidden = [env.ANAF_CLIENT_ID, env.ANAF_CLIENT_SECRET, 'integration-private-access', 'integration-private-refresh'];
    for (const value of forbidden) {
        assert.equal(status.text.includes(value), false);
        assert.equal(JSON.stringify(row).includes(value), false);
        assert.equal(logs.includes(value), false);
    }
    // Two independent database adapters serialize refresh of the same encrypted grant.
    let refreshes = 0;
    const gateway = { exchange: async () => ({ access_token: 'short-lived', refresh_token: 'refresh-once', expires_in: 1, obtained_at: new Date().toISOString() }),
        verify: async () => {}, refresh: async () => {
            refreshes++;
            await new Promise(resolve => setTimeout(resolve, 50));
            return { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, obtained_at: new Date().toISOString() };
        } };
    const one = new AnafConnection(cfg, repo, gateway);
    const two = new AnafConnection(cfg, otherRepo, gateway);
    const concurrentStart = await one.begin(new Sessions(repo, cfg).fingerprint(session));
    const callback = new URL(`${origin}/callback?code=short&state=${new URL(concurrentStart.url).searchParams.get('state')}`);
    assert.equal(await one.complete(callback, concurrentStart.binding), true);
    assert.deepEqual(await Promise.all([one.withAccessToken(async t => t), two.withAccessToken(async t => t)]), ['rotated-access', 'rotated-access']);
    assert.equal(refreshes, 1);
    const late = await begin();
    assert.equal((await request('/api/anaf/disconnect', { method: 'POST', cookie: session })).status, 201);
    assert.equal((await request(late.callback, { cookie: late.binding })).headers.location, '/?view=connections&anaf=failed&reason=attempt_missing');
    assert.equal((await repo.connection()).encrypted, null);
    const logoutPending = await begin();
    await request('/api/logout', { method: 'POST', cookie: session });
    assert.equal((await request(logoutPending.callback, { cookie: logoutPending.binding })).headers.location, '/?view=connections&anaf=failed&reason=session_expired');
    console.log('PASS: browser connect/disconnect/reconnect, immediate provider denial and retry, HTTPS callback, encrypted storage, refresh, logout and redaction. No ANAF requests made.');
} catch (error) {
    for (const line of logs.split('\n').filter(line => /^ANAF connection (start|return) failed/.test(line))) console.error(line);
    throw error;
} finally {
    provider.close();
    provider.closeAllConnections();
    child.kill('SIGTERM');
    await exited;
    await Promise.all([repo.close(), otherRepo.close(), pool.end()]);
    await databaseAdmin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await databaseAdmin.end();
}
