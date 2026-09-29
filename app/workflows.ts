import type { AnafGateway, InvoiceFiles, JobQueue, NotificationChannel, Repository } from './contracts.js';
import { invoiceXml, parseInvoice } from './invoice-xml.js';
import { addedTimestamp, AnafHttpError, receivedInvoices } from '../src/anaf.ts';
import { logFailure, logInfo } from './diagnostics.js';

export class Workflows {
    constructor(private repo: Repository, private gateway: AnafGateway, private files: InvoiceFiles,
        private queue: JobQueue, private email: NotificationChannel, private emailEnabled: boolean, private available: () => Promise<boolean> = async () => true) {}

    async sync() {
        let stage = 'connection';
        let entityId: string | undefined;
        let messageId: string | undefined;
        let days: number | undefined;
        const started = Date.now();
        try {
            if (!await this.available()) return;
            const company = await this.repo.company();
            entityId = company.id;
            stage = 'sync_window';
            const backfill = await this.repo.addedDateBackfillPending();
            days = backfill || !company.lastSync ? 60
                : Math.min(60, Math.max(2, Math.ceil((Date.now() - Date.parse(company.lastSync)) / 86400000) + 1));
            stage = 'invoice_list';
            const messages = receivedInvoices(await this.gateway.list(days));
            let imported = 0;
            for (const message of messages) {
                messageId = message.id;
                const anafDate = addedTimestamp(message.data_creare);
                stage = 'invoice_lookup';
                if (await this.repo.hasInvoice(message.id)) {
                    stage = 'added_date_update';
                    await this.repo.updateInvoiceAddedDate(message.id, anafDate);
                    continue;
                }
                stage = 'invoice_download';
                const archive = await this.gateway.download(message.id);
                stage = 'invoice_parse';
                const xml = invoiceXml(archive);
                const data = parseInvoice(xml);
                // The original ZIP is durable before the invoice/outbox transaction. A crash can
                // leave an orphan ZIP, which a later sync can safely reuse.
                stage = 'archive_store';
                await this.files.put(message.id, 'zip', archive);
                stage = 'invoice_insert';
                await this.repo.insertInvoice(message.id, data, company.initialized, anafDate);
                imported++;
            }
            messageId = undefined;
            stage = 'added_date_backfill';
            if (backfill) await this.repo.markAddedDateBackfilled();
            stage = 'sync_finish';
            await this.repo.finishSync();
            logInfo('worker', 'sync_complete', { entityId, count: imported, days, durationMs: Date.now() - started });
        } catch (error) {
            logFailure('worker', stage, error, { entityId, eventId: messageId, days, durationMs: Date.now() - started });
            const reason = error instanceof AnafHttpError ? `ANAF returned HTTP ${error.status}. Collection will retry.`
                : 'Synchronization failed. Check the ANAF connection and retry.';
            try { await this.repo.finishSync(reason); }
            catch (storageError) { logFailure('worker', 'sync_failure_record', storageError, { entityId }); }
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
        let stage = 'event_lookup';
        const started = Date.now();
        try {
            const invoice = await this.repo.invoice(event.invoiceId);
            if (!invoice) throw new Error('Invoice no longer exists.');
            if (event.kind === 'invoice.pdf') {
                stage = 'pdf_convert';
                const bytes = await this.gateway.pdf(invoiceXml(await this.files.read(invoice.messageId, 'zip')));
                stage = 'pdf_store';
                await this.files.put(invoice.messageId, 'pdf', bytes);
                stage = 'pdf_ready';
                await this.repo.pdfReady(invoice.id);
            } else if (this.emailEnabled) {
                stage = 'email_send';
                await this.email.send(invoice, event.id);
            } else {
                stage = 'event_skip';
                await this.repo.completeEvent(event.id, true);
                return;
            }
            stage = 'event_complete';
            await this.repo.completeEvent(event.id);
            logInfo('worker', 'event_complete', { entityId: event.companyId, eventId: id,
                kind: event.kind, durationMs: Date.now() - started });
        } catch (error) {
            logFailure('worker', stage, error, { entityId: event.companyId, eventId: id,
                kind: event.kind, durationMs: Date.now() - started });
            const reason = error instanceof AnafHttpError ? `ANAF returned HTTP ${error.status}. The task will retry.`
                : 'Background task failed. Check the service connection and retry.';
            try { await this.repo.failEvent(id, reason); }
            catch (storageError) { logFailure('worker', 'event_failure_record', storageError,
                { entityId: event.companyId, eventId: id, kind: event.kind }); }
            throw new Error(reason);
        }
    }
}
