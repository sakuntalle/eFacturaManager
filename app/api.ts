import 'reflect-metadata';
import { createServer } from 'node:https';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Body, Controller, Delete, Get, Post, Param, Query, Res, Req, Module, BadRequestException, NotFoundException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import type { Request, Response, NextFunction } from 'express';
import { runtime } from './runtime.js';
import { DEFAULT_CONNECTION_ID } from './adapters/postgres.js';
import { entityInput } from './entity-input.js';
import type { ConnectionFailure } from './connection-errors.js';
import { Sessions, SESSION_COOKIE } from './sessions.js';
import { ADMIN_USERNAME, passwordHash, verifyPassword } from './admin-auth.js';
import { diagnosticReference, logFailure, logInfo } from './diagnostics.js';
import { PasswordResets } from './password-reset.js';
import { SmtpNotificationChannel } from './adapters/email.js';
import { bulkInvoiceIds, createInvoiceBundle } from './invoice-bundle.js';
import { publicSmtp, smtpInput } from './smtp-settings.js';

const app = await runtime().catch(error => { logFailure('web', 'startup', error); process.exit(1); });
const bindingCookie = 'efactura_oauth';
const bindingOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/callback' };
const sessions = new Sessions(app.repo, app.cfg);
const attempts = new Map<string, { count: number; until: number }>();
const resetAttempts = new Map<string, { count: number; until: number }>();
function rateLimited(key: string, limit: number, duration: number): boolean {
    const previous = resetAttempts.get(key);
    const current = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + duration };
    current.count++;
    resetAttempts.set(key, current);
    return current.count > limit;
}
function uuid(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid identifier.');
    return id;
}
function operation(path: string): 'authentication' | 'connection' | 'companies' | 'invoices' | 'sync' | 'settings' | 'events' | 'other' {
    if (['/api/login', '/api/logout', '/api/session', '/api/password'].includes(path)
        || path.startsWith('/api/password-reset/')) return 'authentication';
    if (path.startsWith('/api/anaf/') || path.startsWith('/api/connections') || path === '/callback') return 'connection';
    if (path.startsWith('/api/companies')) return 'companies';
    if (path.startsWith('/api/invoices')) return 'invoices';
    if (path === '/api/sync') return 'sync';
    if (path === '/api/settings') return 'settings';
    if (path.startsWith('/api/events')) return 'events';
    return 'other';
}
@Controller('api')
class ApiController {
    private async selected(id?: string) {
        if (id !== undefined) uuid(id);
        if (id && !await app.repo.findCompany(id)) throw new NotFoundException('Entity not found.');
        return app.scope(id);
    }
    @Get('health') health() { return { ok: true }; }
    @Post('password-reset/request') requestPasswordReset(@Body() body: { email?: unknown }, @Req() req: Request) {
        const email = typeof body?.email === 'string' ? body.email.trim() : '';
        const emailKey = createHash('sha256').update(email.toLowerCase()).digest('hex');
        const ipLimited = rateLimited(`ip:${req.ip ?? 'unknown'}`, 10, 60 * 60 * 1000);
        const emailLimited = !ipLimited && rateLimited(`email:${emailKey}`, 3, 60 * 60 * 1000);
        if (!ipLimited && !emailLimited) {
            void app.repo.smtpSettings().then(smtp => new PasswordResets(app.repo,
                new SmtpNotificationChannel({ ...app.cfg, smtp }), app.cfg.publicUrl).request(email)).catch(error => logFailure('web', 'password_reset_request', error,
                { operation: 'authentication' }));
        }
        return { message: 'If this email address is registered, a password reset link will be sent.' };
    }
    @Post('password-reset/complete') async completePasswordReset(@Body() body: { token?: unknown; newPassword?: unknown },
        @Req() req: Request, @Res() res: Response) {
        if (rateLimited(`complete:${req.ip ?? 'unknown'}`, 20, 60 * 60 * 1000)) {
            res.status(429).json({ message: 'Too many reset attempts. Try again later.' }); return;
        }
        if (typeof body?.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 128) {
            res.status(400).json({ message: 'Choose a password with 12 to 128 characters.' }); return;
        }
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
            res.status(400).json({ message: 'This reset link is invalid or has expired.' }); return;
        }
        const completed = await new PasswordResets(app.repo, new SmtpNotificationChannel({ ...app.cfg,
            smtp: await app.repo.smtpSettings() }), app.cfg.publicUrl).complete(body.token, passwordHash(body.newPassword));
        if (!completed) { res.status(400).json({ message: 'This reset link is invalid or has expired.' }); return; }
        res.clearCookie(SESSION_COOKIE, sessions.cookieOptions()).json({ ok: true });
    }
    @Post('login') async login(@Body() body: { username?: string; password?: string; rememberMe?: boolean }, @Req() req: Request, @Res() res: Response) {
        if (body?.rememberMe !== undefined && typeof body.rememberMe !== 'boolean') throw new BadRequestException('Remember me must be a boolean.');
        const key = req.ip ?? 'local';
        const previous = attempts.get(key);
        const attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60000 };
        if (++attempt.count > 10) { res.status(429).json({ message: 'Too many attempts. Try again in a minute.' }); return; }
        attempts.set(key, attempt);
        const admin = await app.repo.adminAccount();
        if (body?.username !== ADMIN_USERNAME || typeof body?.password !== 'string'
            || !admin || !verifyPassword(body.password, admin.passwordHash)) {
            res.status(401).json({ message: 'Invalid username or password.' }); return;
        }
        await sessions.revoke(req.headers.cookie);
        const { token, cookie } = await sessions.create(body.rememberMe === true);
        res.cookie(SESSION_COOKIE, token, cookie);
        res.json({ username: ADMIN_USERNAME, mustChangePassword: admin.mustChangePassword });
    }
    @Get('session') async session() {
        const admin = await app.repo.adminAccount();
        if (!admin) throw new Error('Administrator account is missing.');
        return { username: ADMIN_USERNAME, mustChangePassword: admin.mustChangePassword };
    }
    @Post('password') async changePassword(@Body() body: { currentPassword?: string; newPassword?: string; rememberMe?: boolean },
        @Res() res: Response) {
        if (body?.rememberMe !== undefined && typeof body.rememberMe !== 'boolean') {
            res.status(400).json({ message: 'Remember me must be a boolean.' }); return;
        }
        const admin = await app.repo.adminAccount();
        if (typeof body?.currentPassword !== 'string' || !admin
            || !verifyPassword(body.currentPassword, admin.passwordHash)) {
            res.status(400).json({ message: 'Current password is incorrect.' }); return;
        }
        if (typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 128
            || body.newPassword === body.currentPassword) {
            res.status(400).json({ message: 'Choose a different password with 12 to 128 characters.' }); return;
        }
        if (!await app.repo.changeAdminPassword(admin.passwordHash, passwordHash(body.newPassword))) {
            res.status(409).json({ message: 'Password changed in another session. Sign in again.' }); return;
        }
        const { token, cookie } = await sessions.create(body.rememberMe === true);
        res.cookie(SESSION_COOKIE, token, cookie).json({ username: ADMIN_USERNAME, mustChangePassword: false });
    }
    @Post('logout') async logout(@Req() req: Request, @Res() res: Response) {
        await sessions.revoke(req.headers.cookie);
        res.clearCookie(SESSION_COOKIE, sessions.cookieOptions()).json({ ok: true });
    }
    @Post('anaf/connect') async connect(@Req() req: Request, @Res() res: Response) {
        return this.connectManaged(DEFAULT_CONNECTION_ID, req, res);
    }
    @Post('anaf/connections/:id/connect') async connectManaged(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
        try {
            const result = await (await app.connectionFor(uuid(id))).begin(sessions.fingerprint(req.headers.cookie)!);
            res.cookie(bindingCookie, `${id}.${result.binding}`, { ...bindingOptions, maxAge: 300000 });
            res.status(303).setHeader('Location', result.url).end();
        } catch (error) {
            logFailure('web', 'connection_start', error, { operation: 'connection' });
            res.status(303).setHeader('Location', '/?view=connections&anaf=failed&reason=start_failed').end();
        }
    }
    @Post('anaf/disconnect') async disconnect() {
        if (!app.connection) throw new NotFoundException('ANAF connection not found.');
        await app.connection.disconnect();
        return { ok: true };
    }
    @Post('anaf/connections/:id/disconnect') async disconnectManaged(@Param('id') id: string) {
        await (await app.connectionFor(uuid(id))).disconnect();
        return { ok: true };
    }
    @Post('connections') async createConnection(@Body() body: { name?: unknown }) {
        if (typeof body?.name !== 'string' || !body.name.trim() || body.name.trim().length > 100
            || /[\u0000-\u001f\u007f]/u.test(body.name)) {
            throw new BadRequestException('Enter a connection name of at most 100 characters.');
        }
        return app.repo.createManagedConnection(body.name.trim());
    }
    @Get('status') async status(@Query('companyId') companyId?: string) {
        if (companyId !== undefined) uuid(companyId);
        const companies = await app.repo.companies();
        const company = companyId ? companies.find(item => item.id === companyId) : companies[0];
        if (companyId && !company) throw new NotFoundException('Entity not found.');
        const connections = await Promise.all((await app.repo.managedConnections()).map(async managed => ({
            ...managed,
            status: managed.verificationCIF ? await (await app.connectionFor(managed.id)).status()
                : { state: 'needs_entity', canConnect: false, connectedAt: null },
        })));
        const smtp = await app.repo.smtpSettings();
        return { company: company ?? null, companies, connections, diagnosticRef: company ? diagnosticReference(company.id) : null,
            emailEnabled: !!company?.emailEnabled && smtp.configured, emailTo: company?.emailTo ?? app.cfg.smtp.to,
            smtp: publicSmtp(smtp),
            connection: connections.find(item => item.id === company?.connectionId)?.status
                ?? { state: 'needs_entity', canConnect: false, connectedAt: null } };
    }
    @Post('companies') async createCompany(@Body() body: Record<string, unknown>) {
        let input;
        try { input = entityInput(body); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid entity settings.'); }
        const connectionId = body.connectionId === undefined ? DEFAULT_CONNECTION_ID : uuid(String(body.connectionId));
        if (!await app.repo.managedConnection(connectionId)) throw new BadRequestException('Choose an ANAF connection.');
        try { return await app.repo.createCompany(input, connectionId); }
        catch (error) {
            if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
                throw new BadRequestException('This fiscal identifier is already configured.');
            }
            throw error;
        }
    }
    @Post('companies/:id') async updateCompany(@Param('id') id: string, @Body() body: Record<string, unknown>) {
        const item = await this.selected(id);
        let input;
        try { input = entityInput(body); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid entity settings.'); }
        if (input.CIF !== item.company.CIF || input.kind !== item.company.kind) {
            throw new BadRequestException('Entity type and fiscal identifier cannot be changed after setup.');
        }
        const connectionId = body.connectionId === undefined ? item.company.connectionId : uuid(String(body.connectionId));
        if (!await app.repo.managedConnection(connectionId)) throw new BadRequestException('Choose an ANAF connection.');
        return item.repo.updateCompany(input, connectionId);
    }
    @Delete('companies/:id') async deleteCompany(@Param('id') id: string) {
        const result = await app.repo.deleteCompany(uuid(id));
        if (!result.deleted) throw new NotFoundException('Entity not found.');
        return result;
    }
    @Get('invoices') async invoices(@Query('search') search?: string, @Query('companyId') companyId?: string,
        @Query('sortBy') sortBy?: string, @Query('direction') direction?: string, @Query('page') page?: string) {
        if (sortBy !== undefined && sortBy !== 'issue' && sortBy !== 'added') throw new BadRequestException('Invalid invoice sort field.');
        if (direction !== undefined && direction !== 'asc' && direction !== 'desc') throw new BadRequestException('Invalid invoice sort direction.');
        if (page !== undefined && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) {
            throw new BadRequestException('Invalid invoice page.');
        }
        return (await this.selected(companyId)).repo.invoicePage(typeof search === 'string' ? search.slice(0, 100) : '',
            sortBy ?? 'added', direction ?? 'desc', page === undefined ? 1 : Number(page), 50);
    }
    @Get('invoices/selection') async invoiceSelection(@Query('search') search?: string,
        @Query('companyId') companyId?: string) {
        const invoices = await (await this.selected(companyId)).repo.invoices(typeof search === 'string' ? search.slice(0, 100) : '');
        return { items: invoices.map(invoice => ({ id: invoice.id, pdfReady: invoice.pdfReady })) };
    }
    @Get('invoices/:id') async invoice(@Param('id') id: string, @Query('companyId') companyId?: string) {
        const invoice = await (await this.selected(companyId)).repo.invoice(uuid(id));
        if (!invoice) throw new NotFoundException();
        return invoice;
    }
    @Post('invoices/bulk/:kind') async bulkDownload(@Param('kind') kind: string,
        @Body() body: { invoiceIds?: unknown }, @Query('companyId') companyId: string | undefined, @Res() res: Response) {
        if (kind !== 'zip' && kind !== 'pdf') throw new NotFoundException();
        let ids: string[];
        try { ids = bulkInvoiceIds(body?.invoiceIds).map(uuid); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid invoice selection.'); }
        const item = await this.selected(companyId);
        const invoices = await Promise.all(ids.map(id => item.repo.invoice(id)));
        if (invoices.some(invoice => !invoice)) throw new BadRequestException('Some selected invoices are unavailable.');
        if (kind === 'pdf' && invoices.some(invoice => !invoice!.pdfReady)) {
            throw new BadRequestException('A selected PDF is still being prepared.');
        }
        const bytes = await createInvoiceBundle(invoices.map(invoice => invoice!), kind,
            (messageId, documentKind) => item.files.read(messageId, documentKind));
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${kind === 'zip' ? 'zips' : 'pdfs'}.zip"`);
        res.send(Buffer.from(bytes));
    }
    @Get('invoices/:id/:kind') async download(@Param('id') id: string, @Param('kind') kind: string,
        @Query('companyId') companyId: string | undefined, @Res() res: Response) {
        if (kind !== 'zip' && kind !== 'pdf') throw new NotFoundException();
        const item = await this.selected(companyId);
        const invoice = await item.repo.invoice(uuid(id));
        if (!invoice || (kind === 'pdf' && !invoice.pdfReady)) throw new NotFoundException('Document is not ready.');
        const bytes = await item.files.read(invoice.messageId, kind);
        res.setHeader('Content-Type', kind === 'zip' ? 'application/zip' : 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.messageId}.${kind}"`);
        res.send(bytes);
    }
    @Post('sync') async sync(@Query('companyId') companyId?: string) {
        const item = await this.selected(companyId);
        if (!await item.connection.available()) throw new BadRequestException('Connect this entity to ANAF first.');
        await app.queue.publish('sync', { companyId: item.company.id });
        return { queued: true };
    }
    @Post('settings') async settings(@Body() body: { pollSeconds?: number }, @Query('companyId') companyId?: string) {
        if (!Number.isInteger(body?.pollSeconds) || body.pollSeconds! < 15 || body.pollSeconds! > 86400) throw new BadRequestException('Polling interval must be 15–86400 seconds.');
        await (await this.selected(companyId)).repo.updatePoll(body.pollSeconds!);
        return { saved: true };
    }
    @Post('settings/smtp') async saveSmtp(@Body() body: Record<string, unknown>) {
        try { await app.repo.saveSmtpSettings(smtpInput(body)); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid SMTP settings.'); }
        return { saved: true };
    }
    @Get('events') async events(@Query('companyId') companyId?: string) { return (await this.selected(companyId)).repo.events(); }
    @Post('events/:id/retry') async replay(@Param('id') id: string, @Query('companyId') companyId?: string) {
        if (!await (await this.selected(companyId)).repo.replayEvent(uuid(id))) throw new BadRequestException('Only failed or skipped events can be retried.');
        return { queued: true };
    }
}
@Module({ imports: [ServeStaticModule.forRoot({ rootPath: resolve('dist/web'), exclude: ['/api/{*path}'] })], controllers: [ApiController] })
class AppModule {}
const server = await NestFactory.create(AppModule, { logger: false });
server.useGlobalFilters({ catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    logFailure('web', 'request', exception, { operation: operation(req.path), httpStatus: status });
    res.status(status).json({ message: status === 500 ? 'Request failed. Please retry.'
        : exception instanceof HttpException ? exception.message : 'Request failed.' });
} });
server.use(async (req: Request, res: Response, next: NextFunction) => {
    if (app.cfg.tls.certFile && !req.secure && req.path !== '/api/health') {
        res.status(303).setHeader('Location', `${app.cfg.publicUrl}/`).end(); return;
    }
    // Preserve Origin on same-origin form POSTs without sending referrers to ANAF.
    if (req.method === 'GET' && req.path === '/'
        && new URL(req.originalUrl, app.cfg.publicUrl).searchParams.has('reset')) {
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
    } else res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path === '/callback') {
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        let connected = false;
        let failure: ConnectionFailure = 'invalid_return';
        let connectionId = DEFAULT_CONNECTION_ID;
        try {
            const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${bindingCookie}=`))?.slice(bindingCookie.length + 1) ?? '';
            const split = cookie.indexOf('.');
            connectionId = split < 0 ? DEFAULT_CONNECTION_ID : cookie.slice(0, split);
            const binding = split < 0 ? cookie : cookie.slice(split + 1);
            if (req.method === 'GET' && /^[0-9a-f-]{36}$/i.test(connectionId)) {
                connected = await (await app.connectionFor(connectionId)).complete(new URL(req.originalUrl, app.cfg.publicUrl), binding, (step, status) => {
                failure = step;
                console.warn(`ANAF connection return failed: ${step}${status ? ` (HTTP ${status})` : ''}.`);
                });
            }
        } catch (error) { failure = 'storage_or_processing'; logFailure('web', 'connection_return', error, { operation: 'connection' }); }
        res.clearCookie(bindingCookie, bindingOptions);
        res.status(303).setHeader('Location', connected ? `/?view=connections&anaf=connected&connection=${connectionId}`
            : `/?view=connections&anaf=failed&reason=${failure}`).end();
        return;
    }
    if (!req.path.startsWith('/api/')) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== app.cfg.publicUrl) {
        res.status(403).json({ message: 'Request origin does not match APP_PUBLIC_URL.' }); return;
    }
    try {
        if (!['/api/login', '/api/health', '/api/password-reset/request', '/api/password-reset/complete'].includes(req.path)
            && !await sessions.valid(req.headers.cookie)) {
            res.status(401).json({ message: 'Please sign in.' }); return;
        }
        if (!['/api/login', '/api/health', '/api/session', '/api/password', '/api/logout',
            '/api/password-reset/request', '/api/password-reset/complete'].includes(req.path)
            && (await app.repo.adminAccount())?.mustChangePassword) {
            res.status(403).json({ message: 'Change the administrator password before continuing.' }); return;
        }
        next();
    } catch (error) {
        logFailure('web', 'session_validation', error, { operation: operation(req.path) });
        res.status(500).json({ message: 'Request failed. Please retry.' });
    }
});
let tlsServer: ReturnType<typeof createServer> | undefined;
if (app.cfg.publicUrl.startsWith('https:')) {
    try {
        if (!app.cfg.tls.certFile || !app.cfg.tls.keyFile) {
            throw new Error('HTTPS requires APP_TLS_CERT_FILE and APP_TLS_KEY_FILE.');
        }
        const [cert, key] = await Promise.all([readFile(app.cfg.tls.certFile!), readFile(app.cfg.tls.keyFile!)]);
        await server.init();
        tlsServer = createServer({ cert, key, minVersion: 'TLSv1.2' }, server.getHttpAdapter().getInstance());
        await new Promise<void>((resolve, reject) => {
            tlsServer!.once('error', reject);
            tlsServer!.listen(app.cfg.port, '0.0.0.0', resolve);
        });
    } catch (error) { logFailure('web', 'https_startup', error); process.exit(1); }
} else await server.listen(app.cfg.port, '0.0.0.0');
logInfo('web', 'started');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    tlsServer?.close();
    await server.close(); await app.queue.close(); await app.repo.close(); process.exit(0);
});
