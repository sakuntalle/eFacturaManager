import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Config } from '../config.js';
import type { Invoice, NotificationChannel } from '../contracts.js';
import { logFailure } from '../diagnostics.js';

export class SmtpNotificationChannel implements NotificationChannel {
    private transport: Transporter;
    constructor(private cfg: Config, private entityName?: string, private companyId?: string) {
        const smtp = cfg.smtp;
        this.transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port,
            secure: smtp.secure, requireTLS: smtp.requireTLS,
            auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
            connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
            disableFileAccess: true, disableUrlAccess: true,
        });
    }
    async send(invoice: Invoice, eventId: string) {
        const prefix = this.cfg.mode === 'mock' ? '[SIMULATED ANAF] ' : '';
        try {
            const info = await this.transport.sendMail({
                from: this.cfg.smtp.from, to: this.cfg.smtp.to,
                messageId: `<${eventId}@efactura.local>`,
                subject: `${prefix}New invoice${this.entityName ? ` for ${this.entityName}` : ''} ${invoice.number} — ${invoice.supplier}`,
                text: `${prefix}A new invoice is available.${this.entityName ? `\nEntity: ${this.entityName}` : ''}\n\nSupplier: ${invoice.supplier}\nInvoice: ${invoice.number}\n`
                    + `Issued: ${invoice.issueDate}\nInvoice amount: ${invoice.total} ${invoice.currency}\n\n`
                    + `${this.cfg.publicUrl}/?invoice=${invoice.id}${this.companyId ? `&companyId=${this.companyId}` : ''}\n`,
            });
            if (!info.accepted?.length || info.rejected?.length) throw new Error('Recipient rejected.');
        } catch (error) {
            logFailure('email', 'send', error, { entityId: this.companyId, eventId });
            throw new Error('SMTP delivery failed. Check provider settings and recipient; delivery will retry.');
        }
    }
}
