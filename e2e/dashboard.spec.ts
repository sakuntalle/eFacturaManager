import { test, expect, type Page } from '@playwright/test';

const companyId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';

function invoice(supplier: string, number: string) {
    return { id: 'invoice-1', messageId: '900001', number, supplier, supplierCif: 'RO1234',
        issueDate: '2026-09-25', addedDate: '2026-09-27T14:35', dueDate: '2026-10-25',
        currency: 'RON', net: '1234.56', tax: '0.00', total: '1234.56', pdfReady: true,
        lines: [{ description: 'Test item', quantity: '1', amount: '1234.56' }] };
}

async function workspace(page: Page, mode: 'mock' | 'live') {
    let pollSeconds = 60;
    let lastSync: string | null = null;
    let createdInvoice: ReturnType<typeof invoice> | null = null;
    let synchronized = false;
    let invoiceRequests = 0;
    const initialInvoice = invoice('Office supplier', 'TEST-1');
    const company = () => ({ id: companyId, connectionId, name: 'Test company', kind: 'company',
        cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true, mode,
        environment: 'prod', initialized: true, pollSeconds, lastSync,
        nextSync: '2026-09-28T12:00:00Z', syncError: null });
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (path === '/api/status') return route.fulfill({ json: { mode, company: company(), companies: [company()],
            emailEnabled: true, emailTo: 'developer@example.test', diagnosticRef: null,
            connections: [{ id: connectionId, name: 'Test authorization', verificationCif: '12345678',
                entityIds: [companyId], status: { state: mode === 'mock' ? 'mock' : 'connected',
                    canConnect: false, connectedAt: null } }],
            connection: { state: mode === 'mock' ? 'mock' : 'connected', canConnect: false, connectedAt: null } } });
        if (path === '/api/invoices') {
            const items = mode === 'mock' ? synchronized && createdInvoice ? [createdInvoice] : [] : [initialInvoice];
            const search = url.searchParams.get('search')?.toLowerCase() ?? '';
            const matches = items.filter(item => `${item.supplier} ${item.number}`.toLowerCase().includes(search));
            return route.fulfill({ json: { items: matches, total: matches.length, allTotal: items.length,
                page: 1, pageSize: 50 } });
        }
        if (path === '/api/events') return route.fulfill({ json: [] });
        if (path === `/api/companies/${companyId}` && route.request().method() === 'POST') {
            pollSeconds = route.request().postDataJSON().pollSeconds;
            return route.fulfill({ json: company() });
        }
        if (path === '/api/mock') {
            if (route.request().method() === 'POST') {
                const body = route.request().postDataJSON();
                if (body.action === 'invoice') {
                    invoiceRequests++;
                    createdInvoice = invoice(body.supplierName, 'DEMO-0001');
                    return route.fulfill({ json: { created: { number: createdInvoice.number } } });
                }
            }
            return route.fulfill({ json: { scenario: 'normal' } });
        }
        if (path === '/api/sync') {
            synchronized = true;
            lastSync = '2026-09-28T12:00:01Z';
            return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({ json: [] });
    });
    return { invoiceRequests: () => invoiceRequests, pollSeconds: () => pollSeconds };
}

test('administrator can browse invoices, inspect details, change polling and use mobile layout', async ({ page }, info) => {
    const state = await workspace(page, 'live');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await page.locator('.invoice-link').first().click();
    await expect(page.locator('.details')).toBeVisible();
    await expect(page.locator('.details .totals')).toContainText('Invoice amount 1234.56 RON');
    await page.getByRole('button', { name: 'Close invoice details' }).click();
    await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Settings' }).click();
    const interval = page.getByLabel('Polling interval (seconds)');
    await interval.fill('45');
    await page.getByRole('button', { name: 'Save entity settings' }).click();
    await expect(page.getByRole('status')).toContainText('Entity settings saved');
    expect(state.pollSeconds()).toBe(45);
    await page.getByRole('navigation', { name: 'Entity views' }).getByRole('button', { name: 'Invoices' }).click();
    await page.getByLabel('Search invoices').fill('no-such-supplier');
    await expect(page.getByRole('heading', { name: 'No matching invoices' })).toBeVisible();
    await page.getByLabel('Search invoices').fill('');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
});

test('simulated invoice form supports cancellation, validation and custom invoice creation', async ({ page }, info) => {
    const state = await workspace(page, 'mock');
    await page.goto('/');
    await page.getByRole('button', { name: /Mocked ANAF/ }).click();
    const create = page.getByRole('button', { name: /Create simulated invoice/ });
    const dialog = page.getByRole('dialog', { name: 'Create simulated invoice' });
    await create.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Supplier name')).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(create).toBeFocused();
    expect(state.invoiceRequests()).toBe(0);
    await create.click();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await create.click();
    const supplier = 'Browser & Supplies';
    await dialog.getByLabel('Supplier name').fill(supplier);
    await dialog.getByLabel('Amount (RON)').fill('0');
    await page.getByRole('button', { name: 'Create invoice', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('greater than zero');
    expect(state.invoiceRequests()).toBe(0);
    await dialog.getByLabel('Amount (RON)').fill('1234,56');
    await expect(dialog.getByRole('alert')).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeInViewport();
    await page.screenshot({ path: info.outputPath('invoice-form.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Create invoice', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status')).toContainText('Simulated invoice DEMO-0001 created');
    expect(state.invoiceRequests()).toBe(1);
    await page.getByRole('button', { name: /Sync now/ }).click();
    await page.getByRole('navigation', { name: 'Entity views' }).getByRole('button', { name: 'Invoices' }).click();
    const row = page.getByRole('row').filter({ hasText: supplier });
    await expect(row).toBeVisible();
    await expect(row).toContainText('1234.56 RON');
    await row.getByRole('button').click();
    await expect(page.locator('.details')).toContainText(supplier);
    await expect(page.locator('.details .totals')).toContainText('Invoice amount 1234.56 RON');
    await expect(row.getByRole('link', { name: 'PDF ↓' })).toBeVisible();
});
