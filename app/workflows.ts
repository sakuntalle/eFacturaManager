import type { AnafGateway, InvoiceFiles, JobQueue, NotificationChannel, Repository } from './contracts.js';
import { invoiceXml, parseInvoice } from './invoice-xml.js';
import { AnafHttpError, receivedInvoices } from '../src/anaf.ts';

export class Workflows {
    constructor(private repo: Repository, private gateway: AnafGateway, private files: InvoiceFiles,
        private queue: JobQueue, private email: NotificationChannel, private emailEnabled: boolean, private available: () => Promise<boolean> = async () => true) {}

    async sync() {
        if (!await this.available()) return;
        try {
            const company = await this.repo.company();
            const days = company.lastSync ? Math.min(60, Math.max(2, Math.ceil((Date.now() - Date.parse(company.lastSync)) / 86400000) + 1)) : 60;
            const messages = receivedInvoices(await this.gateway.list(days));
            for (const message of messages) {
                if (await this.repo.hasInvoice(message.id)) continue;
                const archive = await this.gateway.download(message.id);
                const xml = invoiceXml(archive);
                const data = parseInvoice(xml);
                // Files become durable before the DB/outbox transaction. A crash can leave an orphan,
                // which the next idempotent sync safely replaces; never a DB row with absent files.
                await this.files.put(message.id, 'zip', archive);
                await this.files.put(message.id, 'xml', xml);
                await this.repo.insertInvoice(message.id, data, company.initialized);
            }
            await this.repo.finishSync();
        } catch (error) {
            const reason = error instanceof AnafHttpError ? `ANAF returned HTTP ${error.status}. Collection will retry.`
                : 'Synchronization failed. Check the ANAF connection and retry.';
            await this.repo.finishSync(reason);
            throw new Error(reason);
        }
    }
    async dispatch() {
        const connected = await this.available();
        for (const event of await this.repo.pendingEvents()) {
            if (event.kind === 'invoice.pdf' && !connected) continue;
            await this.queue.publish('event', { companyId: event.companyId, eventId: event.id });
            // Crash after publish may cause redelivery. The event status makes completed work a no-op.
            await this.repo.markPublished(event.id);
        }
    }
    async event(id: string) {
        const event = await this.repo.event(id);
        if (!event || event.status !== 'pending') return;
        if (event.kind === 'invoice.pdf' && !await this.available()) return;
        try {
            const invoice = await this.repo.invoice(event.invoiceId);
            if (!invoice) throw new Error('Invoice no longer exists.');
            if (event.kind === 'invoice.pdf') {
                const bytes = await this.gateway.pdf(await this.files.read(invoice.messageId, 'xml'));
                await this.files.put(invoice.messageId, 'pdf', bytes);
                await this.repo.pdfReady(invoice.id);
            } else if (this.emailEnabled) {
                await this.email.send(invoice, event.id);
            } else {
                await this.repo.completeEvent(event.id, true);
                return;
            }
            await this.repo.completeEvent(event.id);
        } catch (error) {
            const reason = error instanceof AnafHttpError ? `ANAF returned HTTP ${error.status}. The task will retry.`
                : 'Background task failed. Check the service connection and retry.';
            await this.repo.failEvent(id, reason);
            throw new Error(reason);
        }
    }
}
