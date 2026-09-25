import { test, expect } from '@playwright/test';

test('admin adds an individual and switches between isolated entity inboxes', async ({ page }) => {
    const first = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace', name: 'First company',
        kind: 'company', cif: '12345678', emailTo: 'first@example.org', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, lastSync: null, nextSync: '', syncError: null, initialized: true };
    const second = { ...first, id: '00000000-0000-4000-8000-000000000002', name: 'Second company', cif: '87654321',
        emailTo: 'second@example.org' };
    const entities = [first, second];
    const requests: string[] = [];
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const id = url.searchParams.get('companyId') ?? first.id;
        requests.push(`${route.request().method()} ${url.pathname} ${id}`);
        if (url.pathname === '/api/status') return route.fulfill({ json: { company: entities.find(e => e.id === id) ?? entities[0] ?? null,
            companies: entities, mode: 'live', emailEnabled: true, emailTo: entities.find(e => e.id === id)?.emailTo ?? 'test@example.org',
            connection: { state: 'connected', canConnect: true, connectedAt: null } } });
        if (url.pathname === '/api/companies' && route.request().method() === 'POST') {
            const input = route.request().postDataJSON();
            const created = { ...first, ...input, id: '00000000-0000-4000-8000-000000000003' };
            entities.push(created);
            return route.fulfill({ json: created });
        }
        if (url.pathname.startsWith('/api/companies/') && route.request().method() === 'DELETE') {
            const index = entities.findIndex(entity => entity.id === url.pathname.split('/').at(-1));
            entities.splice(index, 1);
            return route.fulfill({ json: { deleted: true, nextCompanyId: entities[0]?.id ?? null } });
        }
        if (url.pathname === '/api/invoices') return route.fulfill({ json: { items: [{ id: id,
            number: id === first.id ? 'FIRST-1' : id === second.id ? 'SECOND-1' : 'PERSON-1',
            supplier: 'Test supplier', issueDate: '2026-01-01', total: '10.00', currency: 'RON', pdfReady: false }],
            total: 1, allTotal: 1, page: 1, pageSize: 50 } });
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await expect(page.getByText('FIRST-1')).toBeVisible();
    await page.getByRole('combobox', { name: 'Viewing company or individual' }).selectOption(second.id);
    await expect(page.getByText('SECOND-1')).toBeVisible();
    await expect(page.getByText('FIRST-1')).toHaveCount(0);
    expect(requests).toContain(`GET /api/invoices ${second.id}`);
    await page.getByRole('button', { name: 'Settings' }).click();
    const setup = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Add company or individual' }) });
    await setup.getByRole('button', { name: 'Add entity' }).click();
    await setup.getByRole('group', { name: 'Entity type' }).getByRole('button', { name: 'Individual' }).click();
    await expect(setup.getByLabel('CNP')).toBeVisible();
    await setup.getByLabel('Person name').fill('Test Person');
    await setup.getByLabel('CNP').fill('1234567890123');
    await setup.getByRole('button', { name: 'Add entity', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Viewing company or individual' })).toHaveValue(entities[2].id);
    await page.getByRole('button', { name: 'Invoice inbox' }).click();
    await expect(page.getByText('PERSON-1')).toBeVisible();
    expect(requests).toContain(`GET /api/invoices ${entities[2].id}`);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Delete this individual' }).click();
    const individualDialog = page.getByRole('dialog', { name: 'Delete individual?' });
    await expect(individualDialog).toContainText('all its stored invoices, ZIPs, PDFs and activity');
    await individualDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(individualDialog).toHaveCount(0);
    expect(requests.filter(request => request.startsWith('DELETE'))).toEqual([]);
    await page.getByRole('button', { name: 'Delete this individual' }).click();
    await individualDialog.getByRole('button', { name: 'Delete individual' }).click();
    await expect(page.getByRole('combobox', { name: 'Viewing company or individual' })).toHaveValue(first.id);
    await expect(page.getByRole('combobox', { name: 'Viewing company or individual' }).locator('option')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Viewing company or individual' }).selectOption(second.id);
    await page.getByRole('button', { name: 'Delete this company' }).click();
    await page.getByRole('dialog', { name: 'Delete company?' }).getByRole('button', { name: 'Delete company' }).click();
    await expect(page.getByRole('combobox', { name: 'Viewing company or individual' }).locator('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'Delete this company' }).click();
    await page.getByRole('dialog', { name: 'Delete company?' }).getByRole('button', { name: 'Delete company' }).click();
    await expect(page.getByRole('heading', { name: 'Add a company or individual' })).toBeVisible();
    expect(requests.filter(request => request.startsWith('DELETE')).length).toBe(3);
    await page.getByLabel('Company name').fill('New company');
    await page.getByLabel('CIF / CUI').fill('11223344');
    await page.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.getByRole('combobox', { name: 'Viewing company or individual' })).toHaveValue(entities[0].id);
    await expect(page.getByRole('combobox', { name: 'Viewing company or individual' })).toContainText('New company');
});
