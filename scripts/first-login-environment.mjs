import { randomBytes } from 'node:crypto';

export const FIRST_LOGIN_HTTP_PORT = 3201;
export const FIRST_LOGIN_HTTPS_PORT = 9878;
export const FIRST_LOGIN_LIVE_ORIGIN = `https://localhost:${FIRST_LOGIN_HTTPS_PORT}`;
export const FIRST_LOGIN_MOCK_ORIGIN = `http://localhost:${FIRST_LOGIN_HTTP_PORT}`;

export function isolatedEnvironment(source, databaseName, mode, baseEnv = process.env) {
    if (mode !== 'live' && mode !== 'mock') throw new Error('First-login mode must be live or mock.');
    const database = new URL(source);
    database.pathname = `/${databaseName}`;
    const live = mode === 'live';
    const publicUrl = live ? FIRST_LOGIN_LIVE_ORIGIN : FIRST_LOGIN_MOCK_ORIGIN;
    return {
        ...baseEnv,
        DATABASE_URL: database.toString(),
        APP_DATABASE_NAME: databaseName,
        ADMIN_BOOTSTRAP_DIR: '.local/first-login-demo/admin',
        ANAF_MODE: mode,
        ANAF_CIF: live ? baseEnv.ANAF_CIF : '12345678',
        ANAF_MOCK_URL: 'http://127.0.0.1:8790',
        ANAF_REDIRECT_URI: `${publicUrl}/callback`,
        APP_PUBLIC_URL: publicUrl,
        APP_SESSION_SECRET: randomBytes(32).toString('hex'),
        PORT: String(FIRST_LOGIN_HTTP_PORT),
        APP_TLS_CERT_FILE: live ? '.local/tls/localhost.pem' : '',
        APP_TLS_KEY_FILE: live ? '.local/tls/localhost-key.pem' : '',
        APP_TLS_PORT: String(FIRST_LOGIN_HTTPS_PORT),
        EMAIL_ENABLED: 'false',
        DATA_DIR: '.local/first-login-demo/data',
    };
}
