import { resolve } from 'node:path';
import { selectedDatabaseUrl } from './database-selection.js';

export type AnafMode = 'mock' | 'live';
const HTTPS_CONFIGURATION_ERRORS = {
    https_public_url_required: 'APP_PUBLIC_URL must be an HTTPS origin. Update legacy HTTP settings in .env before starting Docker.',
    tls_port_invalid: 'APP_TLS_PORT must be an integer from 1 to 65535.',
    tls_port_mismatch: 'The local APP_PUBLIC_URL port must match APP_TLS_PORT.',
    tls_files_incomplete: 'Set both APP_TLS_CERT_FILE and APP_TLS_KEY_FILE to enable HTTPS.',
};
export class HttpsConfigurationError extends Error {
    constructor(readonly code: keyof typeof HTTPS_CONFIGURATION_ERRORS) {
        super(HTTPS_CONFIGURATION_ERRORS[code]);
    }
}
export function config(env: NodeJS.ProcessEnv = process.env) {
    const mode = env.ANAF_MODE ?? 'mock';
    if (mode !== 'mock' && mode !== 'live') throw new Error('ANAF_MODE must be mock or live.');
    const environment = env.ANAF_ENV ?? 'prod';
    if (environment !== 'prod' && environment !== 'test') throw new Error('ANAF_ENV must be prod or test.');
    const tlsEnabled = !!env.APP_TLS_CERT_FILE || !!env.APP_TLS_KEY_FILE;
    const requireHttps = tlsEnabled || env.APP_REQUIRE_HTTPS === 'true';
    const tlsPort = Number(env.APP_TLS_PORT ?? 8765);
    if (requireHttps && (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535)) {
        throw new HttpsConfigurationError('tls_port_invalid');
    }
    let publicUrl: URL;
    try {
        publicUrl = new URL(env.APP_PUBLIC_URL || (requireHttps ? `https://localhost:${tlsPort}` : 'http://localhost:3100'));
    } catch {
        if (requireHttps) throw new HttpsConfigurationError('https_public_url_required');
        throw new Error('APP_PUBLIC_URL must be a valid URL.');
    }
    if (requireHttps) {
        if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password
            || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
            throw new HttpsConfigurationError('https_public_url_required');
        }
        if (['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
            && Number(publicUrl.port || 443) !== tlsPort) {
            throw new HttpsConfigurationError('tls_port_mismatch');
        }
        if (tlsEnabled && (!env.APP_TLS_CERT_FILE || !env.APP_TLS_KEY_FILE)) {
            throw new HttpsConfigurationError('tls_files_incomplete');
        }
    }
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
            redirectUri: env.ANAF_REDIRECT_URI || `${publicUrl.origin}/callback`,
            encryptionKey: mode === 'live' ? env.ANAF_TOKEN_ENCRYPTION_KEY ?? '' : '',
        },
        tls: { certFile: env.APP_TLS_CERT_FILE, keyFile: env.APP_TLS_KEY_FILE, port: tlsPort },
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
