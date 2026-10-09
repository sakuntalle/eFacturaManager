import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function workspace(page: Page, mode: 'mock' | 'live') {
    // Exercise mode-dependent presentation without switching the real backend to live ANAF.
    let scenario = 'normal';
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (path === '/api/status') {
            const company = { id: '00000000-0000-4000-8000-000000000001', name: 'Test company', kind: 'company',
                cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true,
                initialized: true, pollSeconds: 60, lastSync: null, syncError: null, environment: 'prod' };
            await route.fulfill({ json: { mode, emailEnabled: true, emailTo: 'developer@example.test', company,
                companies: [company], connection: { state: mode === 'mock' ? 'mock' : 'connected', canConnect: false, connectedAt: null } } });
        } else if (path === '/api/mock') {
            if (route.request().method() === 'POST') scenario = route.request().postDataJSON().value;
            await route.fulfill({ json: { scenario } });
        } else if (path === '/api/invoices') {
            await route.fulfill({ json: { items: [], total: 0, allTotal: 0, page: 1, pageSize: 50 } });
        } else if (path === '/api/events') {
            await route.fulfill({ json: [{ id: 'email-1', invoiceId: 'invoice-1', kind: 'invoice.email', status: 'sent', attempts: 0, createdAt: '2026-09-25T12:00:00Z' }] });
        } else {
            await route.fulfill({ json: [] });
        }
    });
}

test('dark mode persists, stays accessible in the main UI and is inherited by the invoice dialog', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.route('**/api/session', route => route.fulfill({ status: 401, json: {} }));
    await page.goto('/');
    const theme = page.getByRole('switch', { name: 'Dark mode' });
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible();
    await expect(page.locator('.standalone-topbar').getByRole('switch', { name: 'Dark mode' })).toBeVisible();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Forgot password?' })).toBeVisible();
    await expect(page.locator('.standalone-topbar').getByRole('switch', { name: 'Dark mode' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(theme).toBeInViewport();
    await expect(theme).not.toBeChecked();
    await theme.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(theme).toBeChecked();
    await page.screenshot({ path: info.outputPath('dark-login.png'), fullPage: true });
    await workspace(page, 'mock');
    await page.reload();
    await expect(theme).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await expect(page.locator('.topbar').getByRole('switch', { name: 'Dark mode' })).toBeVisible();
    await page.getByRole('button', { name: /Mocked ANAF/ }).click();
    await page.screenshot({ path: info.outputPath('dark-mock.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(theme).toBeInViewport();
    await theme.click();
    await expect(theme).not.toBeChecked();
    await theme.click();
    const darkSurface = await page.locator('.card').first().evaluate(element => getComputedStyle(element).backgroundColor);
    await page.getByRole('button', { name: /Create simulated invoice/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('switch', { name: 'Dark mode' })).toHaveCount(0);
    await expect(dialog).toHaveCSS('background-color', darkSurface);
    await expect(dialog.getByLabel('Supplier name')).toBeFocused();
    await page.screenshot({ path: info.outputPath('dark-mobile-form.png') });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(theme).toBeInViewport();
    await theme.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightSurface = await page.locator('.card').first().evaluate(element => getComputedStyle(element).backgroundColor);
    expect(lightSurface).not.toBe(darkSurface);
    await page.getByRole('button', { name: /Create simulated invoice/ }).click();
    await expect(dialog).toHaveCSS('background-color', lightSurface);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await theme.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(theme).toBeChecked();
});

test('mock controls, notices and notification details are grouped in a mock-only navigation tab', async ({ page }) => {
    await workspace(page, 'mock');
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Mocked ANAF/ })).toBeVisible();
    await expect(page.getByText('Simulated ANAF data', { exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByLabel('Polling interval (seconds)')).toBeVisible();
    await expect(page.getByRole('button', { name: /Create simulated invoice/ })).not.toBeVisible();
    await expect(page.getByLabel('Simulate a service condition')).not.toBeVisible();
    await page.getByRole('button', { name: /Mocked ANAF/ }).click();
    await expect(page.getByText('Simulated ANAF data', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mock invoice notifications' })).toBeVisible();
    await expect(page.locator('.notification-list')).toContainText('Sent');
    await page.getByLabel('Simulate a service condition').selectOption('server-error');
    await expect(page.getByRole('status')).toContainText('Simulator scenario updated.');
    await page.getByRole('button', { name: 'Invoices' }).click();
    await expect(page.getByText('Simulator scenario updated.')).not.toBeVisible();
    await page.unrouteAll();
    await workspace(page, 'live');
    const mockRequests: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/mock') mockRequests.push(request.url()); });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Mocked ANAF/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.getByRole('button', { name: /Create simulated invoice/ })).toHaveCount(0);
    await expect(page.getByText('Simulated ANAF data', { exact: true })).toHaveCount(0);
    expect(mockRequests).toEqual([]);
});
