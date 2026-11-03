import { test, expect } from '@playwright/test';

test('SMTP can be configured before adding an entity and password updates are optional after saving', async ({ page }) => {
    let settings = { host: '', port: 587, secure: false, requireTLS: true, user: '', from: '',
        configured: false, hasPassword: false };
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (path === '/api/status') return route.fulfill({ json: { company: null, companies: [], connections: [],
            emailEnabled: false, emailTo: '', smtp: settings,
            connection: { state: 'needs_entity', canConnect: false, connectedAt: null } } });
        if (path === '/api/settings/smtp') {
            const body = route.request().postDataJSON();
            requests.push(body);
            const { password, ...visible } = body;
            settings = { ...settings, ...visible, configured: true, hasPassword: !!password || settings.hasPassword };
            return route.fulfill({ json: { saved: true } });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Email settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Email settings' })).toBeVisible();
    await page.getByLabel('SMTP host', { exact: true }).fill('smtp.example.test');
    await page.getByLabel('Sender email').fill('sender@example.test');
    await page.getByLabel('SMTP username').fill('test-user');
    await page.getByLabel('SMTP password').fill('synthetic-browser-password');
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect(page.getByRole('status')).toContainText('Email settings saved.');
    await expect(page.getByLabel('SMTP password')).toHaveValue('');
    await expect(page.getByText('Leave the password blank to keep the saved password.')).toBeVisible();
    expect(requests.length).toBe(1);
    expect(requests[0].password === 'synthetic-browser-password').toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Email settings', exact: true }).click();
    await expect(page.getByLabel('SMTP host', { exact: true })).toHaveValue('smtp.example.test');
    await page.getByLabel('SMTP port').fill('465');
    await page.getByLabel('Use implicit TLS').check();
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect('password' in requests[1]).toBe(false);
    await expect(page.getByLabel('SMTP password')).toHaveValue('');
    await page.getByLabel('SMTP password').fill('replacement-synthetic-password');
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect.poll(() => requests.length).toBe(3);
    await expect(page.getByLabel('SMTP password')).toHaveValue('');
});

test('enabling E-invoice notifications keeps SMTP active after saving and reloading each CUI company', async ({ page }) => {
    const companies = ['First company', 'Second company'].map((name, index) => ({
        id: `00000000-0000-4000-8000-00000000000${index + 1}`, name, kind: 'company',
        connectionId: '00000000-0000-4000-8000-000000000003', cif: index ? '87654321' : '12345678',
        emailTo: index ? 'second@example.test' : 'first@example.test', emailEnabled: false,
        mode: 'live', environment: 'prod', pollSeconds: 60, initialized: true, lastSync: null, nextSync: '', syncError: null,
    }));
    let settings = { host: 'smtp.example.test', port: 465, secure: true, requireTLS: false,
        user: 'synthetic-user', from: 'sender@example.test', configured: true, hasPassword: true };
    const connection = { id: companies[0].connectionId, name: 'Shared connection', entityIds: companies.map(company => company.id),
        verificationCif: companies[0].cif, status: { state: 'connected', canConnect: true, connectedAt: null } };
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') {
            const company = companies.find(item => item.id === url.searchParams.get('companyId')) ?? companies[0];
            return route.fulfill({ json: { company, companies, connections: [connection], smtp: settings,
                emailEnabled: company.emailEnabled && settings.configured, emailTo: company.emailTo, connection: connection.status } });
        }
        if (url.pathname === '/api/invoices') return route.fulfill({ json: { items: [], total: 0, allTotal: 0, page: 1, pageSize: 50 } });
        if (url.pathname.startsWith('/api/companies/') && route.request().method() === 'POST') {
            const company = companies.find(item => item.id === url.pathname.split('/').pop())!;
            Object.assign(company, route.request().postDataJSON());
            return route.fulfill({ json: company });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    const notifications = page.locator('.stats > div').filter({ has: page.getByText('Email notifications', { exact: true }) });
    for (const company of companies) {
        await page.locator('.sidebar').getByRole('button', { name: company.name, exact: true }).click();
        await expect(notifications.locator('strong')).toHaveText('Disabled');
        await page.getByRole('navigation', { name: 'Entity views' }).getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page.getByLabel('Notification email', { exact: true })).toHaveValue(company.emailTo);
        const checkbox = page.getByLabel('Send E-invoice notification emails', { exact: true });
        await expect(checkbox).not.toBeChecked();
        await expect(checkbox).toBeEnabled();
        await checkbox.check();
        await page.getByRole('button', { name: 'Save entity settings', exact: true }).click();
        await expect(notifications.locator('strong')).toHaveText('Enabled');
        await page.reload();
        await page.getByRole('navigation', { name: 'Entity views' }).getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(checkbox).toBeChecked();
        await expect(notifications.locator('strong')).toHaveText('Enabled');
        await expect(page.getByLabel('Send invoice emails', { exact: true })).toHaveCount(0);
        const transport = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Email transport', exact: true }) });
        await expect(transport.getByText('smtp.example.test:465', { exact: true })).toBeVisible();
        await expect(transport.getByText('sender@example.test', { exact: true })).toBeVisible();
        await expect(transport.getByText('TLS', { exact: true })).toBeVisible();
        await transport.getByRole('button', { name: 'Open Email settings', exact: true }).click();
        await expect(page.getByLabel('SMTP host', { exact: true })).toHaveValue('smtp.example.test');
        await expect(page.getByLabel('Sender email', { exact: true })).toHaveValue('sender@example.test');
        await expect(page.getByLabel('SMTP password', { exact: true })).toHaveValue('');
    }
    settings = { ...settings, configured: false, host: '', from: '', hasPassword: false };
    companies[0].emailEnabled = false;
    await page.reload();
    await page.locator('.sidebar').getByRole('button', { name: companies[0].name, exact: true }).click();
    await expect(notifications.locator('strong')).toHaveText('Disabled');
    await page.getByRole('navigation', { name: 'Entity views' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Send E-invoice notification emails', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Send E-invoice notification emails', { exact: true })).toBeDisabled();
    await expect(page.getByText('Configure SMTP in Email settings before enabling E-invoice notification emails.', { exact: true })).toBeVisible();
    await expect(page.getByText('SMTP is not configured. Invoice notification emails cannot be sent.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open Email settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Email settings', exact: true })).toBeVisible();
});
