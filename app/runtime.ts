import { AnafConnection } from './connection.js';
import { config } from './config.js';
import { PostgresRepository, WORKSPACE_ID } from './adapters/postgres.js';
import { PostgresJobQueue } from './adapters/queue.js';
import { LocalInvoiceFiles, PostgresInvoiceFiles } from './adapters/files.js';
import { HttpAnafGateway } from './adapters/anaf.js';
import { SmtpNotificationChannel } from './adapters/email.js';
import { invoiceXml, parseInvoice } from './invoice-xml.js';
import { Workflows } from './workflows.js';

export async function runtime() {
    const cfg = config();
    const repo = new PostgresRepository(cfg);
    await repo.initialize();
    await repo.migrateLegacyFiles(async (company, messageId, kind) => {
        try {
            return await new LocalInvoiceFiles({ ...cfg, mode: company.mode, environment: company.environment,
                cif: company.cif }).read(messageId, kind);
        } catch {
            throw new Error('A stored invoice document is missing from the legacy volume. Restore it before starting the app.');
        }
    });
    const queue = new PostgresJobQueue(cfg.databaseUrl, WORKSPACE_ID);
    await queue.start();
    const connection = new AnafConnection(cfg, repo);
    const scope = async (id?: string) => {
        const company = id ? await repo.findCompany(id) : await repo.company();
        if (!company || company.mode !== cfg.mode || company.environment !== cfg.environment) throw new Error('Company not found.');
        const scopedConfig = { ...cfg, cif: company.cif, smtp: { ...cfg.smtp, to: company.emailTo },
            emailEnabled: company.emailEnabled };
        const companyRepo = repo.forCompany(company.id);
        const files = new PostgresInvoiceFiles(companyRepo);
        const workflows = new Workflows(companyRepo, new HttpAnafGateway(scopedConfig, connection), files,
            queue, new SmtpNotificationChannel(scopedConfig, company.name, company.id), scopedConfig.emailEnabled,
            () => connection.available());
        return { company, repo: companyRepo, files, workflows, connection, cfg: scopedConfig, queue };
    };
    for (const company of await repo.companies()) {
        const item = await scope(company.id);
        await item.repo.migrateInvoiceTotals(async messageId => parseInvoice(invoiceXml(await item.files.read(messageId, 'zip'))).total);
    }
    return { cfg, repo, queue, connection, scope };
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;
