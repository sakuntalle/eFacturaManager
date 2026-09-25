import { AnafConnection } from './connection.js';
import { config } from './config.js';
import { PostgresRepository } from './adapters/postgres.js';
import { PostgresJobQueue } from './adapters/queue.js';
import { LocalInvoiceFiles } from './adapters/files.js';
import { HttpAnafGateway } from './adapters/anaf.js';
import { SmtpNotificationChannel } from './adapters/email.js';
import { parseInvoice } from './invoice-xml.js';
import { Workflows } from './workflows.js';

export async function runtime() {
    const cfg = config();
    const repo = new PostgresRepository(cfg);
    await repo.initialize();
    const files = new LocalInvoiceFiles(cfg);
    await repo.migrateInvoiceTotals(async messageId => parseInvoice(await files.read(messageId, 'xml')).total);
    const queue = new PostgresJobQueue(cfg.databaseUrl, (await repo.company()).id);
    await queue.start();
    const connection = new AnafConnection(cfg, repo);
    const workflows = new Workflows(repo, new HttpAnafGateway(cfg, connection), files, queue, new SmtpNotificationChannel(cfg), cfg.emailEnabled, () => connection.available());
    return { cfg, repo, queue, files, workflows, connection };
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;
