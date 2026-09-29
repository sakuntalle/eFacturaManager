import { test, expect } from '@playwright/test';

test('invoice dates sort through the API, defaulting to newest Added date', async ({ page }) => {
    const company = { id: '00000000-0000-4000-8000-000000000001', name: 'Test company', kind: 'company',
        cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, initialized: true, lastSync: null, syncError: null };
    const dates = [
        { number: 'A', issueDate: '2026-08-06', addedDate: '2026-09-03T09:30' },
        { number: 'B', issueDate: '2026-09-01', addedDate: '2026-09-01T08:15' },
        { number: 'C', issueDate: '2026-08-07', addedDate: '2026-09-02T11:00' },
    ];
    const requests: string[] = [];
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') return route.fulfill({ json: { company, companies: [company], mode: 'live',
            emailEnabled: true, emailTo: company.emailTo, connection: { state: 'connected', canConnect: true, connectedAt: null } } });
        if (url.pathname === '/api/invoices') {
            const by = url.searchParams.get('sortBy') ?? 'added';
            const direction = url.searchParams.get('direction') ?? 'desc';
            requests.push(`${by}:${direction}`);
            const field = by === 'issue' ? 'issueDate' : 'addedDate';
            const rows = [...dates].sort((a, b) => direction === 'asc'
                ? a[field].localeCompare(b[field]) : b[field].localeCompare(a[field]));
            return route.fulfill({ json: { items: rows.map((row, index) => ({ ...row, id: `invoice-${row.number}`, messageId: String(index),
                supplier: 'Supplier', supplierCif: '1234', dueDate: '', currency: 'RON', net: '10.00', tax: '0.00',
                total: '10.00', pdfReady: false, lines: [] })), total: rows.length, allTotal: rows.length, page: 1, pageSize: 50 } });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    const numbers = () => page.locator('.invoice-link small').allTextContents();
    await expect.poll(numbers).toEqual(['A', 'C', 'B']);
    await expect(page.getByRole('columnheader', { name: 'Added date' })).toHaveAttribute('aria-sort', 'descending');
    await page.getByRole('button', { name: 'Issue date' }).click();
    await expect.poll(numbers).toEqual(['B', 'C', 'A']);
    await expect(page.getByRole('columnheader', { name: 'Issue date' })).toHaveAttribute('aria-sort', 'descending');
    await page.getByRole('button', { name: 'Issue date' }).click();
    await expect.poll(numbers).toEqual(['A', 'C', 'B']);
    await expect(page.getByRole('columnheader', { name: 'Issue date' })).toHaveAttribute('aria-sort', 'ascending');
    await page.getByRole('button', { name: 'Added date' }).click();
    await expect.poll(numbers).toEqual(['A', 'C', 'B']);
    await expect(page.getByRole('columnheader', { name: 'Added date' })).toHaveAttribute('aria-sort', 'descending');
    await page.getByRole('button', { name: 'Added date' }).click();
    await expect.poll(numbers).toEqual(['B', 'C', 'A']);
    expect(requests).toContain('added:desc');
    expect(requests).toContain('added:asc');
    expect(requests).toContain('issue:desc');
    expect(requests).toContain('issue:asc');
});
