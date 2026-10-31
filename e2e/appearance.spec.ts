import { test, expect, type Page } from '@playwright/test';

async function workspace(page: Page) {
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        const company = { id: '00000000-0000-4000-8000-000000000001', name: 'Test company', kind: 'company',
            cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true,
            initialized: true, pollSeconds: 60, lastSync: null, syncError: null };
        if (path === '/api/status') return route.fulfill({ json: { emailEnabled: false, company, companies: [company],
            connection: { state: 'connected', canConnect: true, connectedAt: null } } });
        if (path === '/api/invoices') return route.fulfill({ json: { items: [], total: 0, allTotal: 0, page: 1, pageSize: 50 } });
        return route.fulfill({ json: [] });
    });
}

test('dark mode persists through sign-in, recovery and mobile entity settings', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.route('**/api/session', route => route.fulfill({ status: 401, json: {} }));
    await page.goto('/');
    const theme = page.getByRole('switch', { name: 'Dark mode' });
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible();
    await expect(theme).not.toBeChecked();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Forgot password?' })).toBeVisible();
    await expect(theme).toBeVisible();
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await theme.click();
    await page.reload();
    await expect(theme).toBeChecked();
    await workspace(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(theme).toBeInViewport();
    const darkSurface = await page.locator('.settings-card').first().evaluate(element => getComputedStyle(element).backgroundColor);
    await theme.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightSurface = await page.locator('.settings-card').first().evaluate(element => getComputedStyle(element).backgroundColor);
    expect(lightSurface).not.toBe(darkSurface);
    await theme.click();
    await page.reload();
    await expect(theme).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('live workspace has no simulator controls or simulator API requests', async ({ page }) => {
    await workspace(page);
    let simulatorRequests = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/mock') simulatorRequests++; });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Mocked ANAF/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: /Create simulated invoice/ })).toHaveCount(0);
    expect(simulatorRequests).toBe(0);
});
