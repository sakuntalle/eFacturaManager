import { test, expect } from '@playwright/test';

test('SMTP can be configured before adding an entity and password updates are optional after saving', async ({ page }) => {
    let settings = { host: '', port: 587, secure: false, requireTLS: true, user: '', from: '',
        configured: false, hasPassword: false };
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (path === '/api/status') return route.fulfill({ json: { company: null, companies: [], connections: [],
            emailEnabled: false, emailTo: '', smtp: settings,
            connection: { state: 'needs_entity', canConnect: false, connectedAt: null } } });
        if (path === '/api/settings/smtp') {
            const body = route.request().postDataJSON();
            requests.push(body);
            const { password, ...visible } = body;
            settings = { ...settings, ...visible, configured: true, hasPassword: !!password || settings.hasPassword };
            return route.fulfill({ json: { saved: true } });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Email settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Email settings' })).toBeVisible();
    await page.getByLabel('SMTP host', { exact: true }).fill('smtp.example.test');
    await page.getByLabel('Sender email').fill('sender@example.test');
    await page.getByLabel('SMTP username').fill('test-user');
    await page.getByLabel('SMTP password').fill('synthetic-browser-password');
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect(page.getByRole('status')).toContainText('Email settings saved.');
    await expect(page.getByLabel('SMTP password')).toHaveValue('');
    await expect(page.getByText('Leave the password blank to keep the saved password.')).toBeVisible();
    expect(requests.length).toBe(1);
    expect(requests[0].password === 'synthetic-browser-password').toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Email settings', exact: true }).click();
    await expect(page.getByLabel('SMTP host', { exact: true })).toHaveValue('smtp.example.test');
    await page.getByLabel('SMTP port').fill('465');
    await page.getByLabel('Use implicit TLS').check();
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect('password' in requests[1]).toBe(false);
    await expect(page.getByLabel('SMTP password')).toHaveValue('');
    await page.getByLabel('SMTP password').fill('replacement-synthetic-password');
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect.poll(() => requests.length).toBe(3);
    await expect(page.getByLabel('SMTP password')).toHaveValue('');
});
