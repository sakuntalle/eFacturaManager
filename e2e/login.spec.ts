import { test, expect } from '@playwright/test';

test('login sends the remember-me choice and sign-out returns to the login page', async ({ page }, info) => {
    const choices: boolean[] = [];
    let signedIn = false;
    await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill(signedIn
            ? { json: { username: 'admin', mustChangePassword: false } }
            : { status: 401, json: { message: 'Please sign in.' } });
        if (path === '/api/login') {
            const body = route.request().postDataJSON();
            expect(body.username).toBe('admin');
            choices.push(body.rememberMe);
            signedIn = true;
            return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        }
        if (path === '/api/logout') {
            signedIn = false;
            return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/status') {
            return route.fulfill({ json: { company: null, companies: [], connections: [], mode: 'mock',
                emailEnabled: false, emailTo: '', diagnosticRef: null,
                connection: { state: 'needs_entity', canConnect: false, connectedAt: null } } });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    const remember = page.getByRole('checkbox', { name: 'Remember me' });
    await expect(remember).not.toBeChecked();
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.screenshot({ path: info.outputPath('login.png'), fullPage: true });
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible();
    await remember.check();
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    expect(choices).toEqual([false, true]);
});
