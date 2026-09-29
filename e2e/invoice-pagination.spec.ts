import { test, expect } from '@playwright/test';

test('all invoices remain reachable through pagination and search', async ({ page }) => {
    const company = { id: '00000000-0000-4000-8000-000000000001', name: 'Test company', kind: 'company',
        cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, initialized: true, lastSync: null, syncError: null };
    const invoices = Array.from({ length: 205 }, (_, index) => ({
        id: `invoice-${index}`, messageId: String(index), number: `TEST-${index}`, supplier: `Supplier ${index}`,
        supplierCif: '1234', issueDate: '2026-09-01', addedDate: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
        dueDate: '', currency: 'RON', net: '10.00', tax: '0.00', total: '10.00', pdfReady: true, lines: [],
    }));
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') return route.fulfill({ json: { company, companies: [company], mode: 'live',
            emailEnabled: true, emailTo: company.emailTo, connection: { state: 'connected', canConnect: true, connectedAt: null } } });
        if (url.pathname === '/api/invoices') {
            const query = url.searchParams.get('search')?.toLowerCase() ?? '';
            const matching = invoices.filter(invoice => `${invoice.number} ${invoice.supplier}`.toLowerCase().includes(query));
            const requestedPage = Number(url.searchParams.get('page') ?? 1);
            const start = (requestedPage - 1) * 50;
            return route.fulfill({ json: { items: matching.slice(start, start + 50), total: matching.length,
                allTotal: invoices.length, page: requestedPage, pageSize: 50 } });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await expect(page.getByText('Invoices collected').locator('..').locator('strong')).toHaveText('205');
    await expect(page.locator('.invoice-row')).toHaveCount(50);
    await expect(page.getByRole('navigation', { name: 'Invoice pages' })).toContainText('Page 1 of 5');
    for (let target = 2; target <= 5; target++) {
        await page.getByRole('button', { name: 'Next' }).click();
        await expect(page.getByRole('navigation', { name: 'Invoice pages' })).toContainText(`Page ${target} of 5`);
        await expect(page.locator('.invoice-row')).toHaveCount(target === 5 ? 5 : 50);
    }
    await expect(page.getByText('TEST-204')).toBeVisible();
    await page.getByLabel('Search invoices').fill('TEST-0');
    await expect(page.getByText('TEST-0', { exact: true })).toBeVisible();
    await expect(page.locator('.invoice-row')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Invoice pages' })).toContainText('Page 1 of 1');
    await expect(page.getByText('Invoices collected').locator('..').locator('strong')).toHaveText('205');
    await page.locator('.invoice-row').click();
    await expect(page.getByRole('complementary', { name: 'Invoice TEST-0' })).toBeVisible();
});
