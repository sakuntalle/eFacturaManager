import { test, expect } from '@playwright/test';

test('queued sync banner disappears when the selected entity finishes syncing', async ({ page }) => {
    const company = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace',
        name: 'Test company', kind: 'company', cif: '12345678', emailTo: 'test@example.org',
        emailEnabled: true, mode: 'live', environment: 'prod', pollSeconds: 60,
        lastSync: '2026-09-25T10:00:00.000Z', nextSync: '2026-09-25T10:01:00.000Z',
        syncError: null, initialized: true };
    let completed = false;
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') return route.fulfill({ json: {
            company: completed ? { ...company, lastSync: '2026-09-26T10:00:00.000Z',
                nextSync: '2026-09-26T10:01:00.000Z' } : company,
            companies: [company], mode: 'live', emailEnabled: true, emailTo: company.emailTo,
            connection: { state: 'connected', canConnect: true, connectedAt: null },
        } });
        if (url.pathname === '/api/invoices') return route.fulfill({ json: {
            items: [], total: 0, allTotal: 0, page: 1, pageSize: 50,
        } });
        if (url.pathname === '/api/events') return route.fulfill({ json: [] });
        if (url.pathname === '/api/sync') return route.fulfill({ json: { queued: true } });
        return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await page.getByRole('button', { name: /Sync now/ }).click();
    await expect(page.getByRole('status')).toContainText('Synchronization queued. The worker will pick it up shortly.');
    await page.getByRole('status').getByRole('button', { name: 'Dismiss notification' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.getByRole('button', { name: /Sync now/ }).click();
    await expect(page.getByRole('status')).toContainText('Synchronization queued. The worker will pick it up shortly.');
    completed = true;
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 10000 });
});
