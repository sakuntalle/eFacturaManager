import { test, expect } from '@playwright/test';

test('fresh admin setup guides connection creation, entity linking and authorization', async ({ page }) => {
    const connectionId = '00000000-0000-4000-8000-000000000123';
    const company = { id: '00000000-0000-4000-8000-000000000124', connectionId,
        name: 'Test company', kind: 'company', cif: '12345678', emailTo: 'owner@example.test',
        emailEnabled: true, mode: 'live', environment: 'prod', initialized: false,
        pollSeconds: 60, lastSync: null, nextSync: '2026-09-28T12:00:00Z', syncError: null };
    let signedIn = false;
    let changedPassword = false;
    let connectionName = '';
    let companyAdded = false;
    let connected = false;
    await page.route('**/api/**', async route => {
        const { pathname } = new URL(route.request().url());
        if (pathname === '/api/session') {
            if (!signedIn) return route.fulfill({ status: 401, json: { message: 'Please sign in.' } });
            return route.fulfill({ json: { username: 'admin', mustChangePassword: !changedPassword } });
        }
        if (pathname === '/api/login') {
            signedIn = true;
            return route.fulfill({ json: { username: 'admin', mustChangePassword: true } });
        }
        if (pathname === '/api/password') {
            changedPassword = true;
            return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        }
        if (pathname === '/api/status') {
            const connections = connectionName ? [{ id: connectionId, name: connectionName,
                verificationCif: companyAdded ? company.cif : null, entityIds: companyAdded ? [company.id] : [],
                status: { state: connected ? 'connected' : companyAdded ? 'disconnected' : 'needs_entity',
                    canConnect: companyAdded && !connected, connectedAt: null } }] : [];
            return route.fulfill({ json: { company: companyAdded ? company : null,
                companies: companyAdded ? [company] : [], connections, mode: 'live',
                emailEnabled: companyAdded, emailTo: companyAdded ? company.emailTo : '', diagnosticRef: null,
                connection: connections[0]?.status ?? { state: 'needs_entity', canConnect: false, connectedAt: null } } });
        }
        if (pathname === '/api/connections') {
            connectionName = route.request().postDataJSON().name;
            return route.fulfill({ json: { id: connectionId, name: connectionName } });
        }
        if (pathname === '/api/companies' && route.request().method() === 'POST') {
            const submitted = route.request().postDataJSON();
            expect(submitted).toMatchObject({ name: company.name, cif: company.cif, connectionId });
            companyAdded = true;
            return route.fulfill({ json: company });
        }
        if (pathname === `/api/anaf/connections/${connectionId}/connect`) {
            expect(route.request().method()).toBe('POST');
            connected = true;
            return route.fulfill({ status: 303, headers: {
                Location: `/?view=connections&anaf=connected&connection=${connectionId}` }, body: '' });
        }
        if (pathname === '/api/invoices') return route.fulfill({ json: { items: [], total: 0, allTotal: 0, page: 1, pageSize: 50 } });
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('temporary-password');
    await page.getByRole('button', { name: /Sign in/ }).click();
    await expect(page.getByRole('heading', { name: 'Change your temporary password' })).toBeVisible();
    await page.getByLabel('Current password').fill('temporary-password');
    await page.getByLabel('New password', { exact: true }).fill('new-secure-password');
    await page.getByLabel('Confirm new password').fill('new-secure-password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    const banner = page.locator('.onboarding-banner');
    await expect(banner).toContainText('Start by adding an ANAF connection.');
    await expect(banner).toContainText('Create a connection, then add a managed company or individual');
    await expect(page.getByRole('heading', { name: 'Connections 0' })).toBeVisible();
    await expect(page.getByText('Primary ANAF connection')).toHaveCount(0);
    await page.locator('.sidebar').getByRole('button', { name: 'Add managed entity' }).click();
    await expect(page.getByRole('heading', { name: 'Add managed entity' })).toBeVisible();
    await expect(page.locator('.onboarding-banner')).toContainText('Add an ANAF connection before adding an entity.');
    await expect(page.locator('.add-entity-card')).toHaveCount(0);
    await page.locator('.onboarding-banner').getByRole('button', { name: 'Manage ANAF connections' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Add ANAF connection' }).click();
    await expect(page.getByLabel('Connection name')).toBeVisible();
    await page.getByLabel('Connection name').fill('My certificate');
    await page.getByRole('button', { name: 'Create connection' }).click();
    await expect(banner).toHaveCount(0);
    const row = page.getByRole('row').filter({ hasText: 'My certificate' });
    await expect(row).toContainText('Add an entity first');
    await expect(row.getByRole('button', { name: 'Connect' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.getByRole('heading', { name: 'Add managed entity' })).toBeVisible();
    await expect(page.getByLabel('ANAF connection')).toHaveValue(connectionId);
    await page.getByLabel('Company name').fill(company.name);
    await page.getByLabel('CIF / CUI').fill(company.cif);
    await page.getByLabel('Notification email').fill(company.emailTo);
    await page.getByRole('button', { name: 'Add entity', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await expect(row).toContainText(company.name);
    await expect(row).toContainText('Disconnected');
    await expect(row.locator('form')).toHaveAttribute('action', `/api/anaf/connections/${connectionId}/connect`);
    await row.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await expect(row).toContainText('Connected');
    await expect(page.getByRole('status')).toContainText('ANAF connected');
});
