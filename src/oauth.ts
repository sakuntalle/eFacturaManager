import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes, X509Certificate } from 'node:crypto';
import { getTokens } from './anaf.ts';
import type { Fetch, Tokens } from './anaf.ts';

export function localRedirect(value: string): URL {
    const uri = new URL(value);
    if (uri.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(uri.hostname)
        || !uri.port || uri.port === '0' || uri.username || uri.password || uri.search || uri.hash) {
        throw new Error('Use an HTTPS localhost/127.0.0.1 callback with an explicit nonzero port and no query or fragment.');
    }
    return uri;
}

export function authorizationUrl(clientId: string, redirectUri: string, state: string): string {
    const url = new URL('https://logincert.anaf.ro/anaf-oauth2/v1/authorize');
    url.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
        token_content_type: 'jwt', state,
    }).toString();
    return url.toString();
}

export function callbackCode(url: URL, expectedState: string): string {
    if (!expectedState || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState) {
        throw new Error('OAuth state mismatch. Restart login; do not disable state validation.');
    }
    if (url.searchParams.has('error')) throw new Error('ANAF authorization was declined or failed.');
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.getAll('code').length !== 1) {
        throw new Error('Missing or ambiguous authorization code.');
    }
    return code;
}

export async function login(config: {
    clientId: string; clientSecret: string; redirectUri: string;
    tlsCertFile?: string; tlsKeyFile?: string;
}, persist: (tokens: Tokens) => Promise<void>, options: {
    fetcher?: Fetch; onReady?: (startUrl: string) => void; timeoutMs?: number;
} = {}): Promise<void> {
    const redirect = localRedirect(config.redirectUri);
    if (!config.tlsCertFile || !config.tlsKeyFile) {
        throw new Error('Set ANAF_TLS_CERT_FILE and ANAF_TLS_KEY_FILE to your locally trusted HTTPS certificate and key. See docs/poc.md.');
    }
    let cert: Buffer;
    let key: Buffer;
    try { [cert, key] = await Promise.all([readFile(config.tlsCertFile), readFile(config.tlsKeyFile)]); }
    catch { throw new Error('Cannot read the local HTTPS certificate/key. Check ANAF_TLS_CERT_FILE and ANAF_TLS_KEY_FILE.'); }
    try {
        const certificate = new X509Certificate(cert);
        const matches = redirect.hostname === '127.0.0.1' ? certificate.checkIP(redirect.hostname) : certificate.checkHost(redirect.hostname);
        if (!matches || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error();
    } catch { throw new Error('The HTTPS certificate must be valid now and cover the registered callback hostname.'); }
    const state = randomBytes(32).toString('hex');
    const startPath = `/connect/${randomBytes(16).toString('hex')}`;
    let processing = false;
    await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
            clearTimeout(timer);
            server.close();
            server.closeIdleConnections();
            error ? reject(error) : resolve();
        };
        let server: ReturnType<typeof createServer>;
        try { server = createServer({ cert, key, minVersion: 'TLSv1.2' }, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            if (req.method !== 'GET' || req.headers.host !== redirect.host) {
                res.writeHead(400).end('Invalid request.'); return;
            }
            const url = new URL(req.url ?? '/', redirect.origin);
            if (url.pathname === startPath) {
                res.writeHead(302, { Location: authorizationUrl(config.clientId, config.redirectUri, state) }).end();
                return;
            }
            if (url.pathname !== redirect.pathname) { res.writeHead(404).end('Not found.'); return; }
            if (processing) { res.writeHead(409).end('Authorization is already being processed.'); return; }
            let code: string;
            try { code = callbackCode(url, state); }
            catch (error) {
                res.writeHead(400).end(error instanceof Error ? error.message : 'Invalid callback.');
                return;
            }
            processing = true;
            clearTimeout(timer);
            try {
                const tokens = await getTokens(config, new URLSearchParams({
                    grant_type: 'authorization_code', code, redirect_uri: config.redirectUri,
                    token_content_type: 'jwt',
                }), options.fetcher);
                await persist(tokens);
                res.end('ANAF connection saved locally. You can close this tab and return to the terminal.');
                finish();
            } catch {
                res.writeHead(502).end('Token exchange or local storage failed. See terminal; no credentials were logged.');
                finish(new Error('Could not exchange/store tokens. Check registration, callback and local file permissions, then run login again.'));
            }
        }); } catch { reject(new Error('Cannot configure HTTPS. Check that the certificate and private key are a matching PEM pair.')); return; }
        const timer = setTimeout(() => finish(new Error('Login timed out. Run login again.')), options.timeoutMs ?? 300_000);
        server.once('error', () => finish(new Error('Cannot start the local callback server. Check whether the port is in use.')));
        server.listen(Number(redirect.port), '127.0.0.1', () => {
            const startUrl = `${redirect.origin}${startPath}`;
            if (options.onReady) options.onReady(startUrl);
            else {
                console.log(`Open this URL in the browser configured for your qualified certificate:\n${startUrl}`);
                console.log('Waiting up to 5 minutes. The HTTPS callback must exactly match the ANAF registration.');
            }
        });
    });
}
