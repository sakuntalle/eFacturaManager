import { test, expect, type Page } from '@playwright/test';

const companyId = '00000000-0000-4000-8000-000000000001';
const connectionId = '00000000-0000-4000-8000-000000000002';

function invoice(supplier: string, number: string) {
    return { id: 'invoice-1', messageId: '900001', number, supplier, supplierCif: 'RO1234',
        issueDate: '2026-09-25', addedDate: '2026-09-27T14:35', dueDate: '2026-10-25',
        currency: 'RON', net: '1234.56', tax: '0.00', total: '1234.56', pdfReady: true,
        lines: [{ description: 'Test item', quantity: '1', amount: '1234.56' }] };
}

async function workspace(page: Page) {
    let pollSeconds = 60;
    let lastSync: string | null = null;
    const initialInvoice = invoice('Office supplier', 'TEST-1');
    const company = () => ({ id: companyId, connectionId, name: 'Test company', kind: 'company',
        cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true, mode: 'live',
        environment: 'prod', initialized: true, pollSeconds, lastSync,
        nextSync: '2026-09-28T12:00:00Z', syncError: null });
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (path === '/api/status') return route.fulfill({ json: { company: company(), companies: [company()],
            emailEnabled: true, emailTo: 'developer@example.test', diagnosticRef: null,
            connections: [{ id: connectionId, name: 'Test authorization', verificationCif: '12345678',
                entityIds: [companyId], status: { state: 'connected',
                    canConnect: false, connectedAt: null } }],
            connection: { state: 'connected', canConnect: false, connectedAt: null } } });
        if (path === '/api/invoices') {
            const items = [initialInvoice];
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
        if (path === '/api/sync') {
            lastSync = '2026-09-28T12:00:01Z';
            return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({ json: [] });
    });
    return { pollSeconds: () => pollSeconds };
}

test('administrator can browse invoices, inspect details, change polling and use mobile layout', async ({ page }, info) => {
    const state = await workspace(page);
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
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

test('table columns can be resized and retain their widths across reloads', async ({ page }) => {
    await workspace(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');

    const supplierHeader = page.getByRole('columnheader', { name: 'Supplier / invoice' });
    const supplierHandle = page.getByRole('separator', { name: 'Resize Supplier / invoice column' });
    const initialWidth = (await supplierHeader.boundingBox())!.width;
    const issueWidth = (await page.getByRole('columnheader', { name: /Issue date/ }).boundingBox())!.width;
    const initialTableLayout = await page.locator('#invoice-table-scroll').evaluate(element => ({
        viewport: element.clientWidth,
        scrollWidth: element.scrollWidth,
        table: element.querySelector('table')!.getBoundingClientRect().width,
    }));
    expect(Math.abs(initialTableLayout.table - initialTableLayout.viewport)).toBeLessThanOrEqual(1);
    expect(initialTableLayout.scrollWidth - initialTableLayout.viewport).toBeLessThanOrEqual(1);
    expect(initialWidth).toBeGreaterThan(issueWidth * 2);
    const handleBounds = (await supplierHandle.boundingBox())!;
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBounds.x + handleBounds.width / 2 + 80, handleBounds.y + handleBounds.height / 2);
    await page.mouse.up();
    const resizedWidth = (await supplierHeader.boundingBox())!.width;
    expect(resizedWidth).toBeGreaterThan(initialWidth + 60);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('efactura-manager:table-widths:invoices')))
        .toContain('supplier');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    expect(Math.abs((await supplierHeader.boundingBox())!.width - resizedWidth)).toBeLessThanOrEqual(1);
    await supplierHandle.dblclick();
    await expect.poll(async () => (await supplierHeader.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('efactura-manager:table-widths:invoices')))
        .not.toContain('supplier');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    expect(Math.abs((await supplierHeader.boundingBox())!.width - initialWidth)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('separator', { name: /^Resize .* column$/ })).toHaveCount(5);

    await page.locator('.invoice-link').first().click();
    await expect(page.locator('.details').getByRole('separator', { name: /^Resize .* column$/ })).toHaveCount(3);
    await page.getByRole('button', { name: 'Close invoice details' }).click();
    await page.getByRole('navigation', { name: 'Entity views' }).getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByRole('separator', { name: /^Resize .* column$/ })).toHaveCount(4);
    await page.getByRole('button', { name: /Manage ANAF connections/ }).click();
    await expect(page.getByRole('separator', { name: /^Resize .* column$/ })).toHaveCount(4);

    await expect.poll(() => page.evaluate(() => ['invoices', 'invoice-lines', 'activity', 'connections'].every(table =>
        localStorage.getItem(`efactura-manager:table-widths:${table}`) !== null))).toBe(true);
});
