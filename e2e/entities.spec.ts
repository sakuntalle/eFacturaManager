import { test, expect } from '@playwright/test';

test('in-app Back restores the previous entity and view across the workspace', async ({ page }) => {
    const first = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace',
        connectionId: '00000000-0000-4000-8000-000000000003', name: 'First company', kind: 'company',
        cif: '12345678', emailTo: 'first@example.org', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, lastSync: null, nextSync: '', syncError: null, initialized: true };
    const second = { ...first, id: '00000000-0000-4000-8000-000000000002', name: 'Second company', cif: '87654321' };
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const id = url.searchParams.get('companyId') ?? first.id;
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') return route.fulfill({ json: {
            company: id === second.id ? second : first, companies: [first, second], mode: 'live',
            emailEnabled: true, emailTo: 'first@example.org',
            connection: { state: 'connected', canConnect: true, connectedAt: null },
        } });
        if (url.pathname === '/api/invoices') return route.fulfill({ json: { items: [],
            total: 0, allTotal: 0, page: 1, pageSize: 50 } });
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByRole('button', { name: 'Back to First company / Invoices' })).toBeVisible();
    await page.locator('.sidebar').getByRole('button', { name: /Second company/ }).click();
    await expect(page.getByRole('button', { name: 'Back to First company / Activity' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to First company / Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Background activity' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to First company / Invoices' }).click();
    await expect(page.getByRole('heading', { name: 'Your invoice inbox' })).toBeVisible();
    await page.locator('.sidebar').getByRole('button', { name: 'Manage ANAF connections' }).click();
    await expect(page.getByRole('button', { name: 'Back to First company / Invoices' })).toBeVisible();
    await page.locator('.sidebar').getByRole('button', { name: 'Add managed entity' }).click();
    await expect(page.getByRole('button', { name: 'Back to ANAF connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to ANAF connections' }).click();
    await page.getByRole('button', { name: 'Back to First company / Invoices' }).click();
    await expect(page.getByRole('button', { name: /^Back to/ })).toHaveCount(0);
});

test('switching companies keeps the workspace visible while invoices load', async ({ page }) => {
    const first = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace', name: 'First company',
        kind: 'company', cif: '12345678', emailTo: 'first@example.org', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, lastSync: null, nextSync: '', syncError: null, initialized: true };
    const second = { ...first, id: '00000000-0000-4000-8000-000000000002', name: 'Second company', cif: '87654321' };
    let releaseSecond: () => void = () => {};
    const secondInvoicesReady = new Promise<void>(resolve => { releaseSecond = resolve; });
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const id = url.searchParams.get('companyId') ?? first.id;
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') return route.fulfill({ json: { company: id === second.id ? second : first,
            companies: [first, second], mode: 'live', emailEnabled: true, emailTo: 'test@example.org',
            connection: { state: 'connected', canConnect: true, connectedAt: null } } });
        if (url.pathname === '/api/invoices') {
            if (id === second.id) await secondInvoicesReady;
            return route.fulfill({ json: { items: [{ id, number: id === second.id ? 'SECOND-1' : 'FIRST-1',
                supplier: 'Test supplier', issueDate: '2026-01-01', total: '10.00', currency: 'RON', pdfReady: false }],
                total: 1, allTotal: 1, page: 1, pageSize: 50 } });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await expect(page.getByText('FIRST-1')).toBeVisible();
    await page.locator('.sidebar').getByRole('button', { name: /Second company/ }).click();
    await expect(page.locator('.shell')).toBeVisible();
    await expect(page.locator('.sidebar').getByRole('button', { name: /First company/ })).toBeVisible();
    await expect(page.locator('.sidebar').getByRole('button', { name: /Second company/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toContainText('Loading invoices and activity');
    await expect(page.getByText('FIRST-1')).toHaveCount(0);
    releaseSecond();
    await expect(page.getByText('SECOND-1')).toBeVisible();
    await expect(page.locator('.shell')).toBeVisible();
});

test('admin adds an individual and switches between isolated entity inboxes', async ({ page }) => {
    const connectionId = '00000000-0000-4000-8000-000000000010';
    const first = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace', name: 'First company',
        connectionId, kind: 'company', cif: '12345678', emailTo: 'first@example.org', emailEnabled: true, mode: 'live', environment: 'prod',
        pollSeconds: 60, lastSync: null, nextSync: '', syncError: null, initialized: true };
    const second = { ...first, id: '00000000-0000-4000-8000-000000000002', name: 'Second company', cif: '87654321',
        emailTo: 'second@example.org' };
    const entities = [first, second];
    const requests: string[] = [];
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        const id = url.searchParams.get('companyId') ?? first.id;
        requests.push(`${route.request().method()} ${url.pathname} ${id}`);
        if (url.pathname === '/api/status') return route.fulfill({ json: { company: entities.find(e => e.id === id) ?? entities[0] ?? null,
            companies: entities, mode: 'live', emailEnabled: true, emailTo: entities.find(e => e.id === id)?.emailTo ?? 'test@example.org',
            connections: [{ id: connectionId, name: 'Test authorization', verificationCif: first.cif,
                entityIds: entities.map(entity => entity.id),
                status: { state: 'connected', canConnect: true, connectedAt: null } }],
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
    await expect(page.getByText('Managed companies')).toBeVisible();
    await expect(page.getByText('Managed individuals')).toBeVisible();
    await expect(page.locator('.sidebar-bottom')).toContainText('admin');
    const views = page.getByRole('navigation', { name: 'Entity views' });
    await expect(views.getByRole('button', { name: 'Invoices' })).toHaveAttribute('aria-current', 'page');
    await expect(views.getByRole('button', { name: 'Activity' })).toBeVisible();
    await expect(views.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('.sidebar .entity-subnav')).toHaveCount(0);
    await expect(page.getByText('FIRST-1')).toBeVisible();
    await page.locator('.sidebar').getByRole('button', { name: /Second company/ }).click();
    await expect(page.getByText('SECOND-1')).toBeVisible();
    await expect(page.getByText('FIRST-1')).toHaveCount(0);
    await expect(page.locator('.sidebar').getByRole('button', { name: /Second company/ })).toHaveAttribute('aria-pressed', 'true');
    await views.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Background activity' })).toBeVisible();
    await expect(views.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.sidebar').getByRole('button', { name: /Second company/ })).toHaveAttribute('aria-pressed', 'true');
    await views.getByRole('button', { name: 'Invoices' }).click();
    await expect(page.getByText('SECOND-1')).toBeVisible();
    expect(requests).toContain(`GET /api/invoices ${second.id}`);
    await page.locator('.sidebar').getByRole('button', { name: 'Add managed entity' }).click();
    const setup = page.locator('.add-entity-card');
    await expect(page.getByRole('heading', { name: 'Add managed entity' })).toBeVisible();
    await expect(views).toHaveCount(0);
    await expect(page.locator('.entity-nav.active')).toHaveCount(0);
    await setup.getByRole('group', { name: 'Entity type' }).getByRole('button', { name: 'Individual' }).click();
    await expect(setup.getByLabel('CNP')).toBeVisible();
    await setup.getByLabel('Person name').fill('Test Person');
    await setup.getByLabel('CNP').fill('1234567890123');
    await setup.getByRole('button', { name: 'Add entity', exact: true }).click();
    await expect(page.locator('.sidebar').getByRole('button', { name: /Test Person/ })).toHaveAttribute('aria-pressed', 'true');
    await views.getByRole('button', { name: 'Invoices' }).click();
    await expect(page.getByText('PERSON-1')).toBeVisible();
    expect(requests).toContain(`GET /api/invoices ${entities[2].id}`);
    await views.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Delete this individual' }).click();
    const individualDialog = page.getByRole('dialog', { name: 'Delete individual?' });
    await expect(individualDialog).toContainText('all its stored invoices, ZIPs, PDFs and activity');
    await individualDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(individualDialog).toHaveCount(0);
    expect(requests.filter(request => request.startsWith('DELETE'))).toEqual([]);
    await page.getByRole('button', { name: 'Delete this individual' }).click();
    await individualDialog.getByRole('button', { name: 'Delete individual' }).click();
    await expect(page.locator('.sidebar').getByRole('button', { name: /First company/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toContainText('Test Person was deleted.');
    await page.getByRole('status').getByRole('button', { name: 'Dismiss notification' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.locator('.entity-nav')).toHaveCount(2);
    await page.locator('.sidebar').getByRole('button', { name: /Second company/ }).click();
    await views.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Delete this company' }).click();
    await page.getByRole('dialog', { name: 'Delete company?' }).getByRole('button', { name: 'Delete company' }).click();
    await expect(page.locator('.entity-nav')).toHaveCount(1);
    await views.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Delete this company' }).click();
    await page.getByRole('dialog', { name: 'Delete company?' }).getByRole('button', { name: 'Delete company' }).click();
    await expect(page.getByRole('heading', { name: 'Add managed entity' })).toBeVisible();
    expect(requests.filter(request => request.startsWith('DELETE')).length).toBe(3);
    await page.getByLabel('Company name').fill('New company');
    await page.getByLabel('CIF / CUI').fill('11223344');
    await page.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.locator('.sidebar').getByRole('button', { name: /New company/ })).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText('Managed companies')).toBeVisible();
    await expect(page.getByText('Managed individuals')).toBeVisible();
    await expect(page.locator('.sidebar-bottom')).toContainText('admin');
    await expect(views.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
