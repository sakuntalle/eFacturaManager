export function integrationOrigin(env = process.env) {
    const url = new URL(env.TEST_APP_URL ?? 'https://localhost:8765');
    if (url.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || url.port === '0') {
        throw new Error('TEST_APP_URL must be a local HTTPS origin.');
    }
    return url.origin;
}
