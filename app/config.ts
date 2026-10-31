import { resolve } from 'node:path';
import { selectedDatabaseUrl } from './database-selection.js';
import { loadAppSecrets, type AppSecrets } from './secrets.js';
import { defaultSmtpSettings } from './smtp-settings.js';

const MIN_SESSION_SECRET_LENGTH = 32;

function required(env: NodeJS.ProcessEnv, name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
}

function port(value: string, name: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`${name} must be a valid port.`);
    return parsed;
}

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
    if (env.ANAF_MODE && env.ANAF_MODE !== 'live') throw new Error('Only live ANAF connections are supported. Remove the legacy ANAF_MODE setting.');
    if (env.ANAF_ENV && env.ANAF_ENV !== 'prod') throw new Error('Only the production ANAF environment is supported.');
    const tlsEnabled = !!env.APP_TLS_CERT_FILE || !!env.APP_TLS_KEY_FILE;
    const requireHttps = tlsEnabled || env.APP_REQUIRE_HTTPS === 'true' || !!env.APP_PUBLIC_URL?.startsWith('https:');
    const tlsPort = Number(env.APP_TLS_PORT ?? 8765);
    if (requireHttps && (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535)) {
        throw new HttpsConfigurationError('tls_port_invalid');
    }
    let publicUrl: URL;
    try {
        publicUrl = new URL(env.APP_PUBLIC_URL || (requireHttps ? `https://localhost:${tlsPort}` : required(env, 'APP_PUBLIC_URL')));
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
    const sessionSecret = env.APP_SESSION_SECRET ?? '';
    if (sessionSecret && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(`APP_SESSION_SECRET requires ${MIN_SESSION_SECRET_LENGTH} characters.`);
    }
    const cif = (env.ANAF_CIF ?? '').replace(/^RO/i, '');
    if (cif && !/^\d{1,30}$/.test(cif)) throw new Error('Set a numeric ANAF_CIF.');
    return {
        cif,
        // Retain the historical database partition and file paths for existing live workspaces.
        mode: 'live' as const,
        environment: 'prod' as const,
        databaseUrl: selectedDatabaseUrl(required(env, 'DATABASE_URL'), env.APP_DATABASE_NAME),
        publicUrl: publicUrl.origin,
        sessionSecret,
        port: publicUrl.protocol === 'https:' ? tlsPort : port(env.PORT ?? '3100', 'PORT'),
        dataDir: resolve(required(env, 'DATA_DIR')),
        secretsDir: resolve(env.APP_SECRETS_DIR || '.local/app-secrets'),
        oauth: {
            clientId: env.ANAF_CLIENT_ID ?? '',
            clientSecret: env.ANAF_CLIENT_SECRET ?? '',
            redirectUri: env.ANAF_REDIRECT_URI || `${publicUrl.origin}/callback`,
            encryptionKey: env.ANAF_TOKEN_ENCRYPTION_KEY ?? '',
        },
        tls: { certFile: env.APP_TLS_CERT_FILE, keyFile: env.APP_TLS_KEY_FILE, port: tlsPort },
        emailEnabled: false,
        smtp: defaultSmtpSettings(),
    };
}
export type Config = ReturnType<typeof config>;

export function withAppSecrets(cfg: Config, secrets: AppSecrets): Config {
    return { ...cfg, sessionSecret: secrets.sessionSecret, oauth: { ...cfg.oauth, encryptionKey: secrets.tokenEncryptionKey } };
}

export async function initializedConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
    const cfg = config(env);
    const secrets = await loadAppSecrets(cfg.secretsDir, { sessionSecret: cfg.sessionSecret,
        tokenEncryptionKey: cfg.oauth.encryptionKey });
    return withAppSecrets(cfg, secrets);
}
