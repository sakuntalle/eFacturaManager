import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    workers: 1,
    timeout: 30_000,
    webServer: {
        command: 'npx vite preview --host 127.0.0.1 --port 3100',
        url: 'http://localhost:3100',
        reuseExistingServer: true,
    },
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100',
        channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
        headless: true,
    },
});
