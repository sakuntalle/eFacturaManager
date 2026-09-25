import { createHmac, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import type { SessionStore } from './contracts.js';

export const SESSION_COOKIE = 'efactura_session';
export const SESSION_DURATION = 8 * 60 * 60 * 1000;
export const REMEMBER_DURATION = 30 * 24 * 60 * 60 * 1000;

export function sessionToken(cookie?: string): string | undefined {
    const token = cookie?.split(';').map(value => value.trim())
        .find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export class Sessions {
    constructor(private store: SessionStore, private cfg: Pick<Config, 'sessionSecret' | 'adminEmail' | 'password' | 'publicUrl'>) {}
    private hash(token: string) {
        // Credential or secret changes invalidate existing sessions without storing credentials.
        return createHmac('sha256', this.cfg.sessionSecret)
            .update(JSON.stringify([this.cfg.adminEmail, this.cfg.password, token])).digest('hex');
    }
    cookieOptions() {
        return { httpOnly: true, sameSite: 'strict' as const, secure: this.cfg.publicUrl.startsWith('https:'), path: '/' };
    }
    async create(rememberMe: boolean) {
        const duration = rememberMe ? REMEMBER_DURATION : SESSION_DURATION;
        const token = randomBytes(32).toString('hex');
        await this.store.saveSession(this.hash(token), new Date(Date.now() + duration));
        return { token, cookie: { ...this.cookieOptions(), ...(rememberMe ? { maxAge: duration } : {}) } };
    }
    fingerprint(cookie?: string): string | undefined {
        const token = sessionToken(cookie);
        return token ? this.hash(token) : undefined;
    }
    async valid(cookie?: string): Promise<boolean> {
        const token = sessionToken(cookie);
        return token ? this.store.hasSession(this.hash(token)) : false;
    }
    async revoke(cookie?: string): Promise<void> {
        const token = sessionToken(cookie);
        if (token) await this.store.deleteSession(this.hash(token));
    }
}
