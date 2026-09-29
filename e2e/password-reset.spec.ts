import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('unknown email gets the same recovery response but no link; registered email can reset once', async ({ page }) => {
    const registeredEmail = 'owner@example.test';
    const token = randomBytes(32).toString('base64url');
    const sentLinks: string[] = [];
    let signedIn = false;
    let used = false;
    let password = 'old-admin-password';
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill(signedIn
            ? { json: { username: 'admin', mustChangePassword: false } }
            : { status: 401, json: { message: 'Please sign in.' } });
        if (url.pathname === '/api/password-reset/request') {
            const { email } = route.request().postDataJSON();
            if (email === registeredEmail) sentLinks.push(`${url.origin}/?reset=${token}`);
            return route.fulfill({ json: {
                message: 'If this email address is registered, a password reset link will be sent.',
            } });
        }
        if (url.pathname === '/api/password-reset/complete') {
            const input = route.request().postDataJSON();
            if (input.token !== token || used) return route.fulfill({ status: 400, json: {
                message: 'This reset link is invalid or has expired.',
            } });
            password = input.newPassword;
            used = true;
            signedIn = false;
            return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname === '/api/login') {
            if (route.request().postDataJSON().password !== password) {
                return route.fulfill({ status: 401, json: { message: 'Invalid username or password.' } });
            }
            signedIn = true;
            return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        }
        if (url.pathname === '/api/status') return route.fulfill({ json: {
            company: null, companies: [], connections: [], mode: 'live', emailEnabled: false,
            emailTo: '', diagnosticRef: null,
            connection: { state: 'needs_entity', canConnect: false, connectedAt: null },
        } });
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Forgot password?' })).toBeVisible();
    await page.getByLabel('Email address').fill('stranger@example.test');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const response = await page.getByRole('status').locator('span').innerText();
    expect(sentLinks).toHaveLength(0);
    await page.getByLabel('Email address').fill(registeredEmail);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status').locator('span')).toHaveText(response);
    expect(sentLinks).toHaveLength(1);
    await page.goto(sentLinks[0]);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page).not.toHaveURL(/reset=/);
    await page.getByLabel('New password', { exact: true }).fill('new-secure-admin-password');
    await page.getByLabel('Confirm new password').fill('new-secure-admin-password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status')).toContainText('Password changed. Sign in with your new password.');
    await page.getByLabel('Password', { exact: true }).fill('new-secure-admin-password');
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await page.goto(sentLinks[0]);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill('another-secure-password');
    await page.getByLabel('Confirm new password').fill('another-secure-password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText('This reset link is invalid or has expired.');
});

test('sending a reset link keeps the recovery form and button visually stable', async ({ page }) => {
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ status: 401, json: { message: 'Please sign in.' } });
        if (path === '/api/password-reset/request') {
            await new Promise(resolve => setTimeout(resolve, 250));
            return route.fulfill({ json: {
                message: 'If this email address is registered, a password reset link will be sent.',
            } });
        }
        return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.getByLabel('Email address').fill('owner@example.test');
    const form = page.locator('.login-card');
    const button = page.getByRole('button', { name: 'Send reset link' });
    const initialTop = (await form.boundingBox())!.y;
    const initialOpacity = await button.evaluate(element => getComputedStyle(element).opacity);
    await button.click();
    await expect(button).toBeDisabled();
    expect(await button.evaluate(element => getComputedStyle(element).opacity)).toBe(initialOpacity);
    await expect(page.getByRole('status')).toContainText('If this email address is registered');
    expect(Math.abs((await form.boundingBox())!.y - initialTop)).toBeLessThan(2);
});
