import { test, expect } from '@playwright/test';

test('invoice details open on the right from a scrolled list and remain usable on mobile', async ({ page }, info) => {
    const invoices = Array.from({ length: 40 }, (_, index) => ({
        id: `invoice-${index}`, number: `TEST-${index}`, supplier: `Supplier ${index}`, supplierCif: 'RO1234',
        messageId: String(900000 + index), issueDate: '2026-09-25', addedDate: '2026-09-27T14:35', dueDate: '2026-10-25', currency: 'RON',
        net: '100.00', tax: '0.00', total: '100.00', pdfReady: true,
        lines: Array.from({ length: 30 }, (_, line) => ({ description: `Invoice item ${line}`, quantity: '1', amount: '3.33' })),
    }));
    await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        const company = { id: '00000000-0000-4000-8000-000000000001', name: 'Test company', kind: 'company',
            cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true,
            pollSeconds: 60, initialized: true, environment: 'prod', lastSync: null, syncError: null };
        const json = path === '/api/status' ? { mode: 'mock', emailEnabled: true, emailTo: 'developer@example.test',
            company, companies: [company], connection: { state: 'mock', canConnect: false, connectedAt: null } }
            : path === '/api/invoices' ? { items: invoices, total: invoices.length, allTotal: invoices.length, page: 1, pageSize: 50 }
                : path === '/api/mock' ? { scenario: 'normal' } : [];
        return route.fulfill({ json });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('.invoice-row').first()).toContainText('25/09/2026');
    await expect(page.getByRole('columnheader', { name: 'Added date' })).toBeVisible();
    await expect(page.locator('.invoice-row').first()).toContainText('27/09/2026 14:35');
    const last = page.locator('.invoice-link').last();
    await page.locator('.invoice-row').last().locator('.amount').click();
    const panel = page.getByRole('complementary', { name: 'Invoice TEST-39' });
    await expect(panel.getByText('25/09/2026', { exact: true })).toBeVisible();
    await expect(panel.getByText('27/09/2026 14:35', { exact: true })).toBeVisible();
    await expect(panel.getByText('25/10/2026', { exact: true })).toBeVisible();
    await expect(panel.getByRole('heading')).toBeInViewport();
    await expect(panel.locator('.totals')).toBeInViewport();
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x + bounds.width).toBe(1440);
    expect(bounds.y).toBeLessThan(100);
    await expect(panel.getByRole('link', { name: 'Download PDF ↓' })).toHaveAttribute('href', '/api/invoices/invoice-39/pdf?companyId=00000000-0000-4000-8000-000000000001');
    await panel.locator('.details-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(panel.getByText('Invoice item 29', { exact: true })).toBeInViewport();
    await expect(panel.getByRole('button', { name: 'Close invoice details' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('right-panel-desktop.png') });
    await page.locator('.invoice-link').nth(38).click();
    const next = page.getByRole('complementary', { name: 'Invoice TEST-38' });
    await expect(next.getByRole('heading')).toBeInViewport();
    await expect(next.getByText('Invoice item 0', { exact: true })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(next).toHaveCount(0);
    await expect(page.locator('.invoice-link').nth(38)).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await last.click();
    await expect(panel.getByRole('heading')).toBeInViewport();
    await expect(panel.getByRole('link', { name: 'Download PDF ↓' })).toBeInViewport();
    expect((await panel.boundingBox())!.width).toBe(390);
    await page.getByRole('switch', { name: 'Dark mode' }).click();
    await page.screenshot({ path: info.outputPath('right-panel-mobile.png') });
    await panel.getByRole('button', { name: 'Close invoice details' }).click();
    await expect(panel).toHaveCount(0);
    await expect(last).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
