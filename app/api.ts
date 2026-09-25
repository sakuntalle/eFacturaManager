import 'reflect-metadata';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Body, Controller, Get, Post, Param, Query, Res, Req, Module, BadRequestException, NotFoundException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import type { Request, Response, NextFunction } from 'express';
import { runtime } from './runtime.js';
import { mockInvoiceInput } from './mock/invoice-input.js';
import type { ConnectionFailure } from './connection-errors.js';
import { Sessions, SESSION_COOKIE } from './sessions.js';

const app = await runtime().catch(() => { console.error('Application startup failed. Check deployment configuration and database availability.'); process.exit(1); });
const bindingCookie = 'efactura_oauth';
const bindingOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/callback' };
const sessions = new Sessions(app.repo, app.cfg);
const attempts = new Map<string, { count: number; until: number }>();
function equals(a: string, b: string) {
    const hash = (s: string) => createHmac('sha256', app.cfg.sessionSecret).update(s).digest();
    return timingSafeEqual(hash(a), hash(b));
}
function uuid(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid identifier.');
    return id;
}
@Controller('api')
class ApiController {
    @Get('health') health() { return { ok: true }; }
    @Post('login') async login(@Body() body: { email?: string; password?: string; rememberMe?: boolean }, @Req() req: Request, @Res() res: Response) {
        if (body?.rememberMe !== undefined && typeof body.rememberMe !== 'boolean') throw new BadRequestException('Remember me must be a boolean.');
        const key = req.ip ?? 'local';
        const previous = attempts.get(key);
        const attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60000 };
        if (++attempt.count > 10) { res.status(429).json({ message: 'Too many attempts. Try again in a minute.' }); return; }
        attempts.set(key, attempt);
        if (typeof body?.email !== 'string' || typeof body?.password !== 'string'
            || !equals(body.email, app.cfg.adminEmail) || !equals(body.password, app.cfg.password)) {
            res.status(401).json({ message: 'Invalid email or password.' }); return;
        }
        await sessions.revoke(req.headers.cookie);
        const { token, cookie } = await sessions.create(body.rememberMe === true);
        res.cookie(SESSION_COOKIE, token, cookie);
        res.json({ ok: true });
    }
    @Post('logout') async logout(@Req() req: Request, @Res() res: Response) {
        await sessions.revoke(req.headers.cookie);
        res.clearCookie(SESSION_COOKIE, sessions.cookieOptions()).json({ ok: true });
    }
    @Post('anaf/connect') async connect(@Req() req: Request, @Res() res: Response) {
        try {
            const result = await app.connection.begin(sessions.fingerprint(req.headers.cookie)!);
            res.cookie(bindingCookie, result.binding, { ...bindingOptions, maxAge: 300000 });
            res.status(303).setHeader('Location', result.url).end();
        } catch (error) {
            // Only a fixed stage and a validated SQLSTATE; never log exception text.
            const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
            console.warn('ANAF connection start failed.', typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `Database code ${code}.` : '');
            res.status(303).setHeader('Location', '/?anaf=failed&reason=start_failed').end();
        }
    }
    @Post('anaf/disconnect') async disconnect() {
        await app.connection.disconnect();
        return { ok: true };
    }
    @Get('status') async status() {
        return { company: await app.repo.company(), emailEnabled: app.cfg.emailEnabled, emailTo: app.cfg.smtp.to, mode: app.cfg.mode, connection: await app.connection.status() };
    }
    @Get('invoices') invoices(@Query('search') search?: string) { return app.repo.invoices(typeof search === 'string' ? search.slice(0, 100) : ''); }
    @Get('invoices/:id') async invoice(@Param('id') id: string) {
        const invoice = await app.repo.invoice(uuid(id));
        if (!invoice) throw new NotFoundException();
        return invoice;
    }
    @Get('invoices/:id/:kind') async download(@Param('id') id: string, @Param('kind') kind: string, @Res() res: Response) {
        if (kind !== 'zip' && kind !== 'pdf') throw new NotFoundException();
        const invoice = await app.repo.invoice(uuid(id));
        if (!invoice || (kind === 'pdf' && !invoice.pdfReady)) throw new NotFoundException('Document is not ready.');
        const bytes = await app.files.read(invoice.messageId, kind);
        res.setHeader('Content-Type', kind === 'zip' ? 'application/zip' : 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.messageId}.${kind}"`);
        res.send(bytes);
    }
    @Post('sync') async sync() {
        if (!await app.connection.available()) throw new BadRequestException('Connect to ANAF in Settings first.');
        const company = await app.repo.company();
        await app.queue.publish('sync', { companyId: company.id });
        return { queued: true };
    }
    @Post('settings') async settings(@Body() body: { pollSeconds?: number }) {
        if (!Number.isInteger(body?.pollSeconds) || body.pollSeconds! < 15 || body.pollSeconds! > 86400) throw new BadRequestException('Polling interval must be 15–86400 seconds.');
        await app.repo.updatePoll(body.pollSeconds!);
        return { saved: true };
    }
    @Get('events') events() { return app.repo.events(); }
    @Post('events/:id/retry') async replay(@Param('id') id: string) {
        if (!await app.repo.replayEvent(uuid(id))) throw new BadRequestException('Only failed or skipped events can be retried.');
        return { queued: true };
    }
    @Get('mock') async mockState() { return this.mockRequest(); }
    @Post('mock') async mockControl(@Body() body: { action?: string; value?: string; supplierName?: unknown; amountRon?: unknown }) {
        if (!['invoice', 'scenario'].includes(body?.action ?? '')) throw new BadRequestException('Invalid mock action.');
        if (body.action === 'invoice') {
            try { return this.mockRequest({ action: 'invoice', ...mockInvoiceInput(body) }); }
            catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid invoice details.'); }
        }
        if (body.action === 'scenario' && !['normal', 'rate-limit', 'server-error', 'unauthorized', 'invalid-zip', 'pdf-error'].includes(body.value ?? '')) throw new BadRequestException('Invalid scenario.');
        return this.mockRequest(body);
    }
    private async mockRequest(body?: { action?: string; value?: string; supplierName?: unknown; amountRon?: unknown }) {
        if (app.cfg.mode !== 'mock') throw new NotFoundException();
        const url = new URL('/control', app.cfg.mockUrl);
        const response = await fetch(url, { method: body ? 'POST' : 'GET',
            headers: { Authorization: 'Bearer mock-only-access-token', 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new BadRequestException('Simulator control failed.');
        return response.json();
    }
}
@Module({ imports: [ServeStaticModule.forRoot({ rootPath: resolve('dist/web'), exclude: ['/api/{*path}'] })], controllers: [ApiController] })
class AppModule {}
const server = await NestFactory.create(AppModule, { logger: false });
server.useGlobalFilters({ catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    res.status(status).json({ message: status === 500 ? 'Request failed. Please retry.'
        : exception instanceof HttpException ? exception.message : 'Request failed.' });
} });
server.use(async (req: Request, res: Response, next: NextFunction) => {
    if (app.cfg.tls.certFile && !req.secure && req.path !== '/api/health') {
        res.status(303).setHeader('Location', `${app.cfg.publicUrl}/`).end(); return;
    }
    // Preserve Origin on same-origin form POSTs without sending referrers to ANAF.
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path === '/callback') {
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        let connected = false;
        let failure: ConnectionFailure = 'invalid_return';
        try {
            const binding = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${bindingCookie}=`))?.slice(bindingCookie.length + 1) ?? '';
            if (req.method === 'GET') connected = await app.connection.complete(new URL(req.originalUrl, app.cfg.publicUrl), binding, (step, status) => {
                failure = step;
                console.warn(`ANAF connection return failed: ${step}${status ? ` (HTTP ${status})` : ''}.`);
            });
        } catch { failure = 'storage_or_processing'; console.warn('ANAF connection return failed: storage_or_processing.'); }
        res.clearCookie(bindingCookie, bindingOptions);
        res.status(303).setHeader('Location', connected ? '/?anaf=connected' : `/?anaf=failed&reason=${failure}`).end();
        return;
    }
    if (!req.path.startsWith('/api/')) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== app.cfg.publicUrl) {
        res.status(403).json({ message: 'Request origin does not match APP_PUBLIC_URL.' }); return;
    }
    try {
        if (!['/api/login', '/api/health'].includes(req.path) && !await sessions.valid(req.headers.cookie)) {
            res.status(401).json({ message: 'Please sign in.' }); return;
        }
        next();
    } catch { res.status(500).json({ message: 'Request failed. Please retry.' }); }
});
await server.listen(app.cfg.port, '0.0.0.0');
let tlsServer: ReturnType<typeof createServer> | undefined;
if (app.cfg.tls.certFile && app.cfg.tls.keyFile) {
    try {
        const [cert, key] = await Promise.all([readFile(app.cfg.tls.certFile), readFile(app.cfg.tls.keyFile)]);
        tlsServer = createServer({ cert, key, minVersion: 'TLSv1.2' }, server.getHttpAdapter().getInstance());
        await new Promise<void>((resolve, reject) => {
            tlsServer!.once('error', reject);
            tlsServer!.listen(app.cfg.tls.port, '0.0.0.0', resolve);
        });
    } catch { console.error('HTTPS startup failed. Check certificate files and port availability.'); process.exit(1); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    tlsServer?.close();
    await server.close(); await app.queue.close(); await app.repo.close(); process.exit(0);
});
