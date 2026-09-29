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

test('connection banner disappears after every linked entity completes its initial invoice collection', async ({ page }) => {
    const connectionId = '00000000-0000-4000-8000-000000000010';
    const firstId = '00000000-0000-4000-8000-000000000011';
    const secondId = '00000000-0000-4000-8000-000000000012';
    let firstReady = false;
    let secondReady = false;
    let statusRequests = 0;
    const company = (id: string, name: string, ready: boolean) => ({ id, connectionId,
        name, kind: 'company', cif: id === firstId ? '12345678' : '87654321',
        emailTo: 'test@example.org', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, initialized: ready, lastSync: ready ? '2026-09-29T10:00:00.000Z' : null,
        nextSync: '2026-09-29T10:01:00.000Z', syncError: null });
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') {
            statusRequests++;
            const companies = [company(firstId, 'First company', firstReady),
                company(secondId, 'Second company', secondReady)];
            return route.fulfill({ json: { company: companies[0], companies, mode: 'live',
                emailEnabled: true, emailTo: 'test@example.org',
                connections: [{ id: connectionId, name: 'New connection', entityIds: [firstId, secondId],
                    status: { state: 'connected', canConnect: true, connectedAt: '2026-09-29T09:00:00.000Z' } }],
                connection: { state: 'connected', canConnect: true, connectedAt: '2026-09-29T09:00:00.000Z' } } });
        }
        if (url.pathname === '/api/invoices') {
            const items = firstReady ? [{ id: '00000000-0000-4000-8000-000000000013',
                messageId: '123456', number: 'INV-1', supplier: 'Test supplier', issueDate: '2026-09-29',
                addedDate: '2026-09-29T10:00:00.000Z', total: '30.25', currency: 'RON', pdfReady: true }] : [];
            return route.fulfill({ json: { items, total: items.length, allTotal: items.length, page: 1, pageSize: 50 } });
        }
        if (url.pathname === '/api/events') return route.fulfill({ json: [] });
        return route.fulfill({ status: 404, json: {} });
    });
    await page.goto(`/?view=connections&anaf=connected&connection=${connectionId}`);
    const banner = page.getByRole('status').filter({ hasText: 'ANAF connected. Initial synchronization will start shortly.' });
    await expect(banner).toBeVisible();
    const firstPoll = statusRequests;
    firstReady = true;
    await expect.poll(() => statusRequests, { timeout: 10000 }).toBeGreaterThan(firstPoll);
    await expect(banner).toBeVisible();
    secondReady = true;
    await expect(banner).toHaveCount(0, { timeout: 10000 });
    await page.locator('.sidebar').getByRole('button', { name: 'First company' }).click();
    await expect(page.getByText('INV-1')).toBeVisible();
});
