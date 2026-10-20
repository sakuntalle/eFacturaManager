import { resolve } from 'node:path';
import { selectedDatabaseUrl } from './database-selection.js';
import type { AppSecrets } from './secrets.js';
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

function publicPort(publicUrl: URL) {
    return port(publicUrl.port || (publicUrl.protocol === 'https:' ? '443' : '80'), 'APP_PUBLIC_URL');
}

export function config(env: NodeJS.ProcessEnv = process.env) {
    const publicUrl = new URL(required(env, 'APP_PUBLIC_URL'));
    const sessionSecret = env.APP_SESSION_SECRET ?? '';
    if (sessionSecret && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(`APP_SESSION_SECRET requires ${MIN_SESSION_SECRET_LENGTH} characters.`);
    }
    const CIF = (env.ANAF_CIF ?? '').replace(/^RO/i, '');
    if (CIF && !/^\d{1,30}$/.test(CIF)) throw new Error('Set a numeric ANAF_CIF.');
    return {
        CIF,
        databaseUrl: selectedDatabaseUrl(required(env, 'DATABASE_URL'), env.APP_DATABASE_NAME),
        publicUrl: publicUrl.origin,
        sessionSecret,
        port: publicUrl.protocol === 'https:' ? port(required(env, 'APP_TLS_PORT'), 'APP_TLS_PORT') : publicPort(publicUrl),
        dataDir: resolve(required(env, 'DATA_DIR')),
        oauth: {
            clientId: env.ANAF_CLIENT_ID ?? '',
            clientSecret: env.ANAF_CLIENT_SECRET ?? '',
            redirectUri: env.ANAF_REDIRECT_URI ?? `${publicUrl.origin}/callback`,
            encryptionKey: env.ANAF_TOKEN_ENCRYPTION_KEY ?? '',
        },
        tls: { certFile: env.APP_TLS_CERT_FILE, keyFile: env.APP_TLS_KEY_FILE },
        emailEnabled: false,
        smtp: defaultSmtpSettings(),
    };
}
export type Config = ReturnType<typeof config>;

export function withAppSecrets(cfg: Config, secrets: AppSecrets): Config {
    return { ...cfg, sessionSecret: secrets.sessionSecret, oauth: { ...cfg.oauth, encryptionKey: secrets.tokenEncryptionKey } };
}
