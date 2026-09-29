import { test, expect } from '@playwright/test';

const primaryId = '00000000-0000-4000-8000-000000000002';
const secondaryId = '00000000-0000-4000-8000-000000000003';

test('admin manages separate ANAF connections and links a new entity without exposing credentials', async ({ page }) => {
    let primaryState = 'disconnected';
    let initialized = false;
    const company = { id: '00000000-0000-4000-8000-000000000001', connectionId: primaryId,
        name: 'Test company', kind: 'company', cif: '12345678', emailTo: 'developer@example.test',
        emailEnabled: true, initialized, pollSeconds: 60, lastSync: null, syncError: null, environment: 'prod' };
    const entities = [company];
    let secondary: { id: string; name: string; verificationCif: string | null; entityIds: string[];
        status: { state: string; canConnect: boolean; connectedAt: string | null } } | null = null;
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        if (path === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (path === '/api/status') {
            const selected = entities.find(entity => entity.id === url.searchParams.get('companyId')) ?? entities[0];
            const primary = { id: primaryId, name: 'Primary ANAF connection', verificationCif: '12345678',
                entityIds: [company.id], status: { state: primaryState, canConnect: true,
                    connectedAt: primaryState === 'connected' ? '2026-09-25T10:00:00Z' : null } };
            const connections = secondary ? [primary, secondary] : [primary];
            return route.fulfill({ json: { mode: 'live', emailEnabled: true, emailTo: selected.emailTo,
                company: { ...selected, initialized: selected.id === company.id ? initialized : selected.initialized },
                companies: entities, connections,
                connection: connections.find(item => item.id === selected.connectionId)?.status } });
        }
        if (path === '/api/connections' && route.request().method() === 'POST') {
            secondary = { id: secondaryId, name: route.request().postDataJSON().name, verificationCif: null,
                entityIds: [], status: { state: 'needs_entity', canConnect: false, connectedAt: null } };
            return route.fulfill({ json: secondary });
        }
        if (path === '/api/companies' && route.request().method() === 'POST') {
            const input = route.request().postDataJSON();
            const created = { ...company, ...input, id: '00000000-0000-4000-8000-000000000004', initialized: false };
            entities.push(created);
            if (secondary) { secondary.entityIds.push(created.id); secondary.verificationCif = created.cif;
                secondary.status = { state: 'disconnected', canConnect: true, connectedAt: null }; }
            return route.fulfill({ json: created });
        }
        if (path === `/api/anaf/connections/${primaryId}/disconnect`) {
            primaryState = 'disconnected'; return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/invoices') return route.fulfill({ json: { items: [], total: 0, allTotal: 0, page: 1, pageSize: 50 } });
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Connect this entity to ANAF' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sync now/ })).toBeDisabled();
    await page.getByRole('button', { name: 'Manage ANAF connections' }).first().click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await expect(page.locator(`form[action="/api/anaf/connections/${primaryId}/connect"]`)).toHaveAttribute('method', 'post');
    await expect(page.getByRole('cell', { name: 'Test company' })).toBeVisible();
    await page.getByRole('row').filter({ hasText: 'Primary ANAF connection' })
        .getByRole('button', { name: 'Test company' }).click();
    await expect(page.getByRole('button', { name: 'Back to ANAF connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to ANAF connections' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await expect(page.getByText(/client.?id|client.?secret/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Mocked ANAF/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Add ANAF connection' }).click();
    await page.getByLabel('Connection name').fill('New ANAF certificate');
    await page.getByRole('button', { name: 'Create connection' }).click();
    const newRow = page.getByRole('row').filter({ hasText: 'New ANAF certificate' });
    await expect(newRow).toContainText('Add an entity first');
    await newRow.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.getByLabel('ANAF connection')).toHaveValue(secondaryId);
    await page.getByRole('button', { name: 'Back to ANAF connections' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await newRow.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.getByRole('button', { name: 'Back to ANAF connections' })).toBeVisible();
    await page.getByLabel('Company name').fill('Second company');
    await page.getByLabel('CIF / CUI').fill('87654321');
    await page.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await expect(newRow).toContainText('Second company');
    await newRow.getByRole('button', { name: 'Second company' }).click();
    await expect(page.locator('.entity-nav').filter({ hasText: 'Second company' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Back to ANAF connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByRole('button', { name: 'Back to Second company / Invoices' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('ANAF connection')).toHaveValue(secondaryId);
    await expect(page.getByRole('heading', { name: 'Connected to ANAF' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to Second company / Activity' }).click();
    await page.getByRole('button', { name: 'Back to Second company / Invoices' }).click();
    await page.getByRole('button', { name: 'Back to ANAF connections' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();
    await expect(page.locator('.entity-nav.active')).toHaveCount(0);
    await expect(newRow).toContainText('Second company');
    await expect(newRow.locator('form')).toHaveAttribute('action', `/api/anaf/connections/${secondaryId}/connect`);
    const primaryRow = page.getByRole('row').filter({ hasText: 'Primary ANAF connection' });
    await primaryRow.getByRole('button', { name: 'Test company' }).click();
    await expect(page.getByRole('button', { name: 'Back to ANAF connections' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to ANAF connections' }).click();
    await expect(page.getByRole('heading', { name: 'Manage ANAF connections' })).toBeVisible();

    primaryState = 'connected'; initialized = true;
    await page.reload();
    await page.getByRole('button', { name: 'Manage ANAF connections' }).first().click();
    await primaryRow.getByRole('button', { name: 'Disconnect' }).click();
    await expect(primaryRow).toContainText('Pause collection for linked entities?');
    await primaryRow.getByRole('button', { name: 'Confirm disconnect' }).click();
    await expect(primaryRow).toContainText('Disconnected');
    await expect(page.getByText(/client.?id|client.?secret/i)).toHaveCount(0);
});
