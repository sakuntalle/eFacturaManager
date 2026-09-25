import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e', workers: 1, timeout: 30_000,
    use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100',
        channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true },
});
