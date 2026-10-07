import { test, expect } from '@playwright/test';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const companyId = '00000000-0000-4000-8000-000000000001';

test('invoices can be selected and bulk-downloaded as ZIP or PDF archives', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const company = { id: companyId, connectionId: '00000000-0000-4000-8000-000000000002', name: 'Test company',
        kind: 'company', cif: '12345678', emailTo: 'developer@example.test', emailEnabled: true, mode: 'live',
        environment: 'prod', initialized: true, pollSeconds: 60, lastSync: null, nextSync: '2026-10-08T10:00:00Z', syncError: null };
    const invoices = Array.from({ length: 125 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, messageId: String(index + 1),
        number: `TEST-${index + 1}`, supplier: index === 0 ? 'First supplier' : index === 1
            ? 'SOCIETATE PROFESIONALĂ NOTARIALĂ - BIROU' : `Supplier ${index + 1}`,
        pdfReady: true,
    })).map(invoice => ({ ...invoice, supplierCif: '1234', issueDate: '2026-10-01', addedDate: '2026-10-01T10:00:00Z',
        dueDate: '', currency: 'RON', net: '10.00', tax: '0.00', total: '10.00', lines: [] }));
    const bulkRequests: { kind: string; ids: string[] }[] = [];
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/session') return route.fulfill({ json: { username: 'admin', mustChangePassword: false } });
        if (url.pathname === '/api/status') return route.fulfill({ json: { company, companies: [company], mode: 'live',
            emailEnabled: true, emailTo: company.emailTo, connection: { state: 'connected', canConnect: true, connectedAt: null } } });
        if (url.pathname === '/api/invoices') return route.fulfill({ json: { items: invoices.slice(0, 50), total: invoices.length,
            allTotal: invoices.length, page: 1, pageSize: 50 } });
        if (url.pathname === '/api/invoices/selection') return route.fulfill({ json: { items: invoices.map(invoice => ({
            id: invoice.id, pdfReady: invoice.pdfReady })) } });
        if (url.pathname.startsWith('/api/invoices/bulk/')) {
            const kind = url.pathname.endsWith('/pdf') ? 'pdf' : 'zip';
            const ids = route.request().postDataJSON().invoiceIds as string[];
            bulkRequests.push({ kind, ids });
            const files = Object.fromEntries(ids.map(id => {
                const current = invoices.find(invoice => invoice.id === id)!;
                return [`invoice-${current.messageId}.${kind}`, strToU8(`${kind}-${current.messageId}`)];
            }));
            return route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from(zipSync(files)) });
        }
        return route.fulfill({ json: [] });
    });
    await page.goto('/');
    const tableScroll = page.locator('#invoice-table-scroll');
    await page.locator('.invoice-row').first().scrollIntoViewIfNeeded();
    const supplierLines = await page.locator('.invoice-supplier').nth(1).evaluate(element => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return { height: element.getBoundingClientRect().height, lineHeight, truncated: element.scrollHeight > element.clientHeight + 1,
            lineClamp: getComputedStyle(element).webkitLineClamp };
    });
    expect(supplierLines.height).toBeGreaterThan(supplierLines.lineHeight * 1.5);
    expect(supplierLines.height).toBeLessThanOrEqual(supplierLines.lineHeight * 2.1);
    expect(supplierLines.truncated).toBe(false);
    expect(supplierLines.lineClamp).toBe('2');
    const scrollSize = await tableScroll.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(scrollSize.clientHeight).toBeLessThanOrEqual(420);
    expect(scrollSize.scrollHeight).toBeGreaterThan(scrollSize.clientHeight);
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    const header = page.getByRole('columnheader', { name: 'Supplier / invoice' });
    const headerTop = (await header.boundingBox())!.y;
    await tableScroll.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => tableScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    expect(Math.abs((await header.boundingBox())!.y - headerTop)).toBeLessThanOrEqual(1);
    const stickyLayers = await tableScroll.evaluate(element => {
        const table = element.querySelector('table')!;
        const head = element.querySelector('thead')!;
        const actions = element.querySelector('.bulk-actions-row')!.getBoundingClientRect();
        const columns = element.querySelector('.invoice-column-headings')!.getBoundingClientRect();
        const points = [actions.top + 2, actions.top + actions.height / 2, columns.top + columns.height / 2];
        return {
            borderCollapse: getComputedStyle(table).borderCollapse,
            isolation: getComputedStyle(head).isolation,
            headerOwnsVisibleLayers: points.every(y => {
                const topElement = document.elementFromPoint(actions.left + 10, y);
                return !!topElement?.closest('thead');
            }),
        };
    });
    expect(stickyLayers).toEqual({ borderCollapse: 'separate', isolation: 'isolate', headerOwnsVisibleLayers: true });
    await page.mouse.wheel(0, -5000);
    await expect.poll(() => tableScroll.evaluate(element => element.scrollTop)).toBe(0);

    const tableBounds = await tableScroll.boundingBox();
    expect(tableBounds!.y + tableBounds!.height).toBeLessThanOrEqual(600);
    expect(await tableScroll.evaluate(element => element.scrollWidth)).toBeGreaterThan(tableBounds!.width);
    await tableScroll.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => tableScroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);

    const selectAll = page.getByRole('checkbox', { name: 'Select all' });
    await expect(selectAll).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select invoice TEST-1 from First supplier' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download selected ZIPs' })).toBeDisabled();

    await selectAll.check();
    await expect(page.getByText('125 selected')).toBeVisible();
    await expect(page.getByRole('separator', { name: 'Resize Select column' })).toBeVisible();
    const firstInvoiceSelection = page.getByRole('checkbox', { name: 'Select invoice TEST-1 from First supplier' });
    await expect(firstInvoiceSelection).toBeVisible();
    await firstInvoiceSelection.uncheck();
    await expect(selectAll).toHaveJSProperty('indeterminate', true);
    const zipDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download selected ZIPs' }).click();
    const downloadedZip = await zipDownload;
    expect(downloadedZip.suggestedFilename()).toBe('invoice-zips.zip');
    const downloadedZipFiles = Object.keys(unzipSync(new Uint8Array(await downloadedZip.createReadStream().then(async stream => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    }))));
    expect(downloadedZipFiles).toHaveLength(124);
    expect(downloadedZipFiles).not.toContain('invoice-1.zip');

    await selectAll.check();
    await expect(page.getByText('125 selected')).toBeVisible();
    const pdfDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download selected PDFs' }).click();
    expect((await pdfDownload).suggestedFilename()).toBe('invoice-pdfs.zip');
    expect(bulkRequests).toEqual([
        { kind: 'zip', ids: invoices.slice(1).map(invoice => invoice.id) },
        { kind: 'pdf', ids: invoices.map(invoice => invoice.id) },
    ]);
    await selectAll.uncheck();
    await expect(firstInvoiceSelection).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});
