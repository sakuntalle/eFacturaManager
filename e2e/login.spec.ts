import { test, expect } from '@playwright/test';

test('remember me controls cookie persistence and logout revokes the remembered session', async ({ page, context, browser }, info) => {
    await page.goto('/');
    const remember = page.getByRole('checkbox', { name: 'Remember me' });
    await expect(remember).not.toBeChecked();
    await page.getByLabel('Email', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Password', { exact: true }).fill('local-development-only');
    await page.screenshot({ path: info.outputPath('login.png'), fullPage: true });
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    const temporary = (await context.cookies()).find(cookie => cookie.name === 'efactura_session')!;
    expect(temporary.expires).toBe(-1);
    expect(temporary.httpOnly).toBe(true);
    expect(temporary.sameSite).toBe('Strict');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Password', { exact: true }).fill('local-development-only');
    await remember.check();
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    const persistent = (await context.cookies()).find(cookie => cookie.name === 'efactura_session')!;
    const remaining = persistent.expires - Date.now() / 1000;
    expect(remaining).toBeGreaterThan(30 * 86400 - 60);
    expect(remaining).toBeLessThanOrEqual(30 * 86400);
    // Restore only cookies that survive a normal browser session ending.
    const restored = await browser.newContext();
    try {
        await restored.addCookies((await context.cookies()).filter(cookie => cookie.expires > Date.now() / 1000));
        const reopened = await restored.newPage();
        await reopened.goto('http://localhost:3100');
        await expect(reopened.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
        await reopened.getByRole('button', { name: 'Sign out' }).click();
        await expect(reopened.getByRole('button', { name: /Sign in/ })).toBeVisible();
        expect((await restored.cookies()).find(cookie => cookie.name === 'efactura_session')).toBeUndefined();
        expect((await context.request.get('/api/status')).status()).toBe(401);
    } finally { await restored.close(); }
});
