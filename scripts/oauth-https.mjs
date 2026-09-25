import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:https';
import { login } from '../src/oauth.ts';

// Uses generated local TLS files with dummy OAuth credentials and tokens only.
// Every token exchange is intercepted; this check never contacts ANAF.
const ca = await readFile(join(execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim(), 'rootCA.pem'));
const credentials = { clientId: 'https-test-client', clientSecret: 'https-test-secret',
    redirectUri: 'https://localhost:8765/callback',
    tlsCertFile: '.local/tls/localhost.pem', tlsKeyFile: '.local/tls/localhost-key.pem' };
function request(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = get(url, { ca, family: 4, servername: new URL(url).hostname, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Local HTTPS request timed out.')));
    });
}
let tokenExchanges = 0;
let saved;
const ready = Promise.withResolvers();
const completed = login(credentials, async tokens => { saved = tokens; }, {
    timeoutMs: 15000,
    onReady: ready.resolve,
    fetcher: async (url, init) => {
        tokenExchanges++;
        assert.equal(String(url), 'https://logincert.anaf.ro/anaf-oauth2/v1/token');
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('redirect_uri'), credentials.redirectUri);
        assert.equal(form.get('code'), 'test-code');
        return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    },
});
completed.catch(ready.reject);
try {
    const startUrl = await ready.promise;
    const start = await request(startUrl);
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.location);
    assert.equal(authorization.searchParams.get('redirect_uri'), credentials.redirectUri);
    assert.equal(authorization.searchParams.get('client_id'), credentials.clientId);
    assert.equal(authorization.searchParams.has('client_secret'), false);
    const state = authorization.searchParams.get('state');
    assert.match(state, /^[a-f0-9]{64}$/);
    assert.equal((await request(`${credentials.redirectUri}?code=test-code&state=wrong`)).status, 400);
    assert.equal((await request(`${credentials.redirectUri}?code=test-code&code=second&state=${state}`)).status, 400);
    assert.equal((await request(startUrl, { Host: 'untrusted.example' })).status, 400);
    assert.equal(tokenExchanges, 0);
    const response = await request(`${credentials.redirectUri}?code=test-code&state=${state}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.includes('synthetic-access'), false);
    await completed;
    assert.equal(tokenExchanges, 1);
    assert.equal(saved.access_token, 'synthetic-access');
    console.log('PASS: verified local HTTPS, exact redirect URI, state/host validation, simulated token exchange and callback shutdown. No ANAF requests were made.');
} catch (error) {
    await completed.catch(() => {});
    console.error(error instanceof Error ? error.message : 'Local HTTPS check failed.');
    process.exitCode = 1;
}
