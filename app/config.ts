import { resolve } from 'node:path';
import { selectedDatabaseUrl } from './database-selection.js';

export type AnafMode = 'mock' | 'live';
export function config(env: NodeJS.ProcessEnv = process.env) {
    const mode = env.ANAF_MODE ?? 'mock';
    if (mode !== 'mock' && mode !== 'live') throw new Error('ANAF_MODE must be mock or live.');
    const environment = env.ANAF_ENV ?? 'prod';
    if (environment !== 'prod' && environment !== 'test') throw new Error('ANAF_ENV must be prod or test.');
    const publicUrl = new URL(env.APP_PUBLIC_URL ?? 'http://localhost:3100');
    const sessionSecret = env.APP_SESSION_SECRET ?? 'local-development-session-secret-change-before-hosting';
    if (!['localhost', '127.0.0.1'].includes(publicUrl.hostname)
        && sessionSecret.startsWith('local-development')) {
        throw new Error('Set a private APP_SESSION_SECRET before network hosting.');
    }
    if (sessionSecret.length < 32) throw new Error('Session secret requires 32 characters.');
    const cif = (env.ANAF_CIF || (mode === 'mock' ? '12345678' : '')).replace(/^RO/i, '');
    if (!/^\d{1,30}$/.test(cif)) throw new Error('Set a numeric ANAF_CIF.');
    const mockUrl = new URL(env.ANAF_MOCK_URL ?? 'http://127.0.0.1:8790');
    if (mockUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', 'anaf-mock'].includes(mockUrl.hostname)) {
        throw new Error('ANAF_MOCK_URL must target the local simulator or the anaf-mock Docker service.');
    }
    return {
        mode: mode as AnafMode, environment: environment as 'prod' | 'test', cif,
        databaseUrl: selectedDatabaseUrl(env.DATABASE_URL ?? 'postgres://efactura:local-development@127.0.0.1:55432/efactura',
            env.APP_DATABASE_NAME),
        publicUrl: publicUrl.origin, sessionSecret,
        port: Number(env.PORT ?? 3100),
        dataDir: resolve(env.DATA_DIR ?? '.local/app'),
        mockUrl: mockUrl.origin,
        oauth: {
            clientId: mode === 'live' ? env.ANAF_CLIENT_ID ?? '' : '',
            clientSecret: mode === 'live' ? env.ANAF_CLIENT_SECRET ?? '' : '',
            redirectUri: env.ANAF_REDIRECT_URI ?? `${publicUrl.origin}/callback`,
            encryptionKey: mode === 'live' ? env.ANAF_TOKEN_ENCRYPTION_KEY ?? '' : '',
        },
        tls: { certFile: env.APP_TLS_CERT_FILE, keyFile: env.APP_TLS_KEY_FILE, port: Number(env.APP_TLS_PORT ?? 8765) },
        emailEnabled: boolean(env.EMAIL_ENABLED ?? 'true', 'EMAIL_ENABLED'),
        smtp: {
            host: env.SMTP_HOST ?? '127.0.0.1', port: Number(env.SMTP_PORT ?? 1025),
            secure: boolean(env.SMTP_SECURE ?? 'false', 'SMTP_SECURE'),
            requireTLS: boolean(env.SMTP_REQUIRE_TLS ?? 'false', 'SMTP_REQUIRE_TLS'),
            user: env.SMTP_USER, password: env.SMTP_PASSWORD,
            from: env.EMAIL_FROM ?? 'eFactura Manager <invoices@example.test>',
            to: env.EMAIL_TO ?? 'developer@example.test',
        },
    };
}

function boolean(value: string, name: string): boolean {
    if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`);
    return value === 'true';
}
export type Config = ReturnType<typeof config>;
