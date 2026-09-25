import { test, expect } from '@playwright/test';

test('live onboarding, connected settings and renewal never present deployment credentials', async ({ page }) => {
    let state = 'disconnected';
    let initialized = false;
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/status') return route.fulfill({ json: { mode: 'live', emailEnabled: true, emailTo: 'developer@example.test',
            company: { cif: '12345678', initialized, pollSeconds: 60, lastSync: null, syncError: null, environment: 'prod' },
            connection: { state, canConnect: state !== 'unconfigured', connectedAt: state === 'connected' ? '2026-09-25T10:00:00Z' : null } } });
        if (path === '/api/anaf/disconnect') { state = 'disconnected'; return route.fulfill({ json: { ok: true } }); }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Connect your company to ANAF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect to ANAF' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sync now/ })).toBeDisabled();
    await expect(page.locator('form[action="/api/anaf/connect"]')).toHaveAttribute('method', 'post');
    await expect(page.getByText(/client.?id|client.?secret/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Mocked ANAF/ })).toHaveCount(0);
    state = 'connected'; initialized = true;
    await page.reload();
    await expect(page.getByRole('button', { name: /Sync now/ })).toBeEnabled();
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByRole('heading', { name: 'Connected to ANAF' })).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect ANAF' }).click();
    await expect(page.getByText(/Downloaded invoices will remain/)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm disconnect' }).click();
    await expect(page.getByRole('heading', { name: 'Connect your company to ANAF' })).toBeVisible();
    state = 'reconnect_required';
    await page.reload();
    await expect(page.getByText(/ANAF authorization needs renewing/)).toBeVisible();
    await page.getByRole('button', { name: 'Manage ANAF connection' }).click();
    await expect(page.getByRole('button', { name: 'Reconnect to ANAF' })).toBeVisible();
    state = 'unconfigured';
    await page.reload();
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByText(/complete the server setup/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect to ANAF' })).toHaveCount(0);
    await expect(page.getByText(/client.?id|client.?secret/i)).toHaveCount(0);
});
