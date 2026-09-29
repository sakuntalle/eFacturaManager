import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { AnafClient, AnafHttpError, getTokens, type Tokens } from '../src/anaf.js';
import { providerFailure, type ConnectionFailure } from './connection-errors.js';
import { authorizationUrl } from '../src/oauth.js';
import type { Config } from './config.js';

import type { ConnectionStatus } from './contracts.js';
export type { ConnectionStatus } from './contracts.js';
export type ConnectionRecord = {
    state: 'disconnected' | 'connected' | 'reconnect_required';
    encrypted: string | null;
    fingerprint: string;
    connectedAt: string | null;
};
export type OAuthAttempt = { state: string; binding: string; session: string; fingerprint: string; expires: number };
export interface ConnectionTransaction {
    read(): Promise<ConnectionRecord | null>;
    write(record: ConnectionRecord): Promise<void>;
    attempt(): Promise<OAuthAttempt | null>;
    saveAttempt(attempt: OAuthAttempt | null): Promise<void>;
    resume(): Promise<void>;
    hasSession(hash: string): Promise<boolean>;
}
export interface ConnectionStore {
    connection(): Promise<ConnectionRecord | null>;
    withConnectionLock<T>(work: (transaction: ConnectionTransaction) => Promise<T>): Promise<T>;
    hasSession(hash: string): Promise<boolean>;
}
export interface OAuthGateway {
    exchange(code: string): Promise<Tokens>;
    refresh(token: string): Promise<Tokens>;
    verify(token: string): Promise<void>;
}
export class LiveOAuthGateway implements OAuthGateway {
    constructor(private cfg: Config) {}
    exchange(code: string) {
        return getTokens(this.cfg.oauth, new URLSearchParams({ grant_type: 'authorization_code', code,
            redirect_uri: this.cfg.oauth.redirectUri, token_content_type: 'jwt' }));
    }
    refresh(token: string) {
        return getTokens(this.cfg.oauth, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }));
    }
    async verify(token: string) { await new AnafClient(this.cfg.environment, token).list(this.cfg.cif, 1); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export type ConnectionFailureReporter = (step: ConnectionFailure, status?: number) => void;
export class ConnectionRequired extends Error {
    constructor() { super('Connect to ANAF in Settings to continue collection.'); }
}
type StoredTokens = Tokens & { expiresAt: number };
export class AnafConnection {
    private key: Buffer;
    private fingerprint: string;
    private ready: boolean;
    private attemptFingerprint: string;
    constructor(private cfg: Config, private store: ConnectionStore, private gateway: OAuthGateway = new LiveOAuthGateway(cfg)) {
        this.key = Buffer.from(cfg.oauth.encryptionKey, 'base64');
        this.ready = cfg.mode === 'live' && !!cfg.oauth.clientId && !!cfg.oauth.clientSecret
            && this.key.length === 32 && cfg.publicUrl.startsWith('https:')
            && cfg.oauth.redirectUri === `${cfg.publicUrl}/callback`;
        this.fingerprint = this.ready ? createHmac('sha256', this.key).update(JSON.stringify([
            cfg.oauth.clientId, cfg.oauth.clientSecret, cfg.oauth.redirectUri, cfg.cif, cfg.environment,
        ])).digest('hex') : '';
        this.attemptFingerprint = createHmac('sha256', cfg.sessionSecret).update(this.fingerprint).digest('hex');
    }
    async status(): Promise<ConnectionStatus> {
        if (this.cfg.mode === 'mock') return { state: 'mock', canConnect: false, connectedAt: null };
        if (!this.ready) return { state: 'unconfigured', canConnect: false, connectedAt: null };
        const row = await this.store.connection();
        return { state: !row || row.state === 'disconnected' ? 'disconnected' : row.fingerprint === this.fingerprint ? row.state : 'reconnect_required',
            canConnect: true, connectedAt: row?.connectedAt ?? null };
    }
    async available() { return ['mock', 'connected'].includes((await this.status()).state); }
    private seal(tokens: StoredTokens): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(this.fingerprint));
        const bytes = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
        return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.');
    }
    private open(value: string): StoredTokens {
        const parts = value.split('.').map(s => Buffer.from(s, 'base64'));
        if (parts.length !== 3) throw new ConnectionRequired();
        const decipher = createDecipheriv('aes-256-gcm', this.key, parts[0]!);
        decipher.setAAD(Buffer.from(this.fingerprint));
        decipher.setAuthTag(parts[1]!);
        const tokens = JSON.parse(Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString()) as StoredTokens;
        if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expiresAt)
            || (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== 'string')) throw new ConnectionRequired();
        return tokens;
    }
    private timed(tokens: Tokens): StoredTokens {
        let expiresAt = Date.now() + 86400000;
        if (tokens.expires_in && Number.isFinite(tokens.expires_in)) expiresAt = Date.now() + tokens.expires_in * 1000;
        else {
            try {
                // A scheduling hint only; the JWT is never used to authenticate an app user.
                const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString());
                if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
            } catch { /* Opaque tokens use a conservative one-day refresh interval. */ }
        }
        return { ...tokens, expiresAt };
    }
    async begin(session: string) {
        if (!this.ready || !await this.store.hasSession(session)) throw new ConnectionRequired();
        const state = randomBytes(32).toString('hex');
        const binding = randomBytes(32).toString('hex');
        await this.store.withConnectionLock(tx => tx.saveAttempt({ state: hash(state), binding: hash(binding), session,
            fingerprint: this.attemptFingerprint, expires: Date.now() + 300000 }));
        return { url: authorizationUrl(this.cfg.oauth.clientId, this.cfg.oauth.redirectUri, state), binding };
    }
    async complete(url: URL, binding: string, report: ConnectionFailureReporter = () => {}): Promise<boolean> {
        const fail = (step: ConnectionFailure, error?: unknown) => {
            report(step, error instanceof AnafHttpError ? error.status : undefined);
            return false;
        };
        const state = url.searchParams.get('state');
        if (!this.ready || !state || !/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(binding)
            || url.searchParams.getAll('state').length !== 1) return fail('invalid_return');
        return this.store.withConnectionLock(async tx => {
            const attempt = await tx.attempt();
            if (!attempt) return fail('attempt_missing');
            if (attempt.state !== hash(state) || attempt.binding !== hash(binding)) return fail('browser_mismatch');
            await tx.saveAttempt(null);
            if (attempt.expires <= Date.now() || attempt.fingerprint !== this.attemptFingerprint) return fail('attempt_expired');
            if (!await tx.hasSession(attempt.session)) return fail('session_expired');
            const code = url.searchParams.get('code');
            if (url.searchParams.has('error')) return fail(providerFailure(url.searchParams.get('error')));
            if (!code || code.length > 8192 || url.searchParams.getAll('code').length !== 1) return fail('invalid_return');
            let step: ConnectionFailure = 'token_exchange';
            try {
                const tokens = await this.gateway.exchange(code);
                step = 'company_access';
                await this.gateway.verify(tokens.access_token);
                step = 'save_connection';
                await tx.write({ state: 'connected', encrypted: this.seal(this.timed(tokens)),
                    fingerprint: this.fingerprint, connectedAt: new Date().toISOString() });
                await tx.resume();
                return true;
            } catch (error) { return fail(step, error); }
        });
    }
    async disconnect() {
        await this.store.withConnectionLock(async tx => {
            await tx.saveAttempt(null);
            await tx.write({ state: 'disconnected', encrypted: null, fingerprint: this.fingerprint, connectedAt: null });
        });
    }
    private async access(rejected?: string): Promise<string> {
        if (!this.ready) throw new ConnectionRequired();
        const result = await this.store.withConnectionLock(async tx => {
            const row = await tx.read();
            if (!row || row.state !== 'connected' || row.fingerprint !== this.fingerprint || !row.encrypted) return { required: true };
            let tokens: StoredTokens;
            const renew = async () => {
                await tx.write({ ...row, state: 'reconnect_required', encrypted: null });
                return { required: true };
            };
            try { tokens = this.open(row.encrypted); } catch { return renew(); }
            if (tokens.expiresAt > Date.now() + 300000 && (!rejected || rejected !== tokens.access_token)) return { token: tokens.access_token };
            if (!tokens.refresh_token) return renew();
            try {
                const refreshed = await this.gateway.refresh(tokens.refresh_token);
                const next = this.timed({ ...refreshed, refresh_token: refreshed.refresh_token || tokens.refresh_token });
                await tx.write({ ...row, encrypted: this.seal(next) });
                return { token: next.access_token };
            } catch (error) {
                if (error instanceof AnafHttpError && [400, 401, 403].includes(error.status)) return renew();
                return { temporary: true };
            }
        });
        if (result.token) return result.token;
        if (result.temporary) throw new Error('ANAF token refresh is temporarily unavailable. Collection will retry.');
        throw new ConnectionRequired();
    }
    async withAccessToken<T>(work: (token: string) => Promise<T>): Promise<T> {
        let token = await this.access();
        try { return await work(token); }
        catch (error) { if (!(error instanceof AnafHttpError) || ![401, 403].includes(error.status)) throw error; }
        token = await this.access(token);
        try { return await work(token); }
        catch (error) {
            if (!(error instanceof AnafHttpError) || ![401, 403].includes(error.status)) throw error;
            await this.store.withConnectionLock(async tx => {
                const row = await tx.read();
                if (row?.encrypted && row.fingerprint === this.fingerprint && this.open(row.encrypted).access_token === token) {
                    await tx.write({ ...row, encrypted: null, state: 'reconnect_required' });
                }
            });
            throw new ConnectionRequired();
        }
    }
}
