import { config as appConfig } from '../../app/config.js';

export function config(env: NodeJS.ProcessEnv = {}) {
    return appConfig({ DATABASE_URL: 'postgres://localhost/efactura_test', DATA_DIR: '.local/test',
        APP_PUBLIC_URL: 'http://localhost:3100', APP_TLS_PORT: '8765',
        APP_SESSION_SECRET: 'test-only-session-secret-with-32-characters', ...env });
}
