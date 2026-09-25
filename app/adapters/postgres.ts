import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Company, Event, Invoice, InvoiceData, Repository, SessionStore } from '../contracts.js';

import type { ConnectionStore, ConnectionRecord, ConnectionTransaction, OAuthAttempt } from '../connection.js';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
// PostgreSQL-specific SQL and migrations remain inside this adapter.
export class PostgresRepository implements Repository, SessionStore, ConnectionStore {
    private pool: pg.Pool;
    private companyId: string;
    private cfg: Config;
    constructor(cfg: Config) {
        this.cfg = cfg;
        this.pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 6 });
        const hex = createHash('sha256').update(`${WORKSPACE}:${cfg.mode}:${cfg.environment}:${cfg.cif}`).digest('hex');
        this.companyId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }
    async initialize() {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(81392001)');
            await client.query(`
                CREATE TABLE IF NOT EXISTS app_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
                CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY, name text NOT NULL);
                CREATE TABLE IF NOT EXISTS companies (
                    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
                    cif text NOT NULL, mode text NOT NULL, environment text NOT NULL,
                    poll_seconds integer NOT NULL DEFAULT 60 CHECK (poll_seconds BETWEEN 15 AND 86400),
                    last_sync timestamptz, next_sync timestamptz NOT NULL DEFAULT now(),
                    sync_error text, initialized boolean NOT NULL DEFAULT false,
                    UNIQUE(workspace_id,cif,mode,environment)
                );
                CREATE TABLE IF NOT EXISTS invoices (
                    id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
                    message_id text NOT NULL, data jsonb NOT NULL,
                    pdf_ready boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
                    UNIQUE(company_id,message_id)
                );
                CREATE TABLE IF NOT EXISTS outbox (
                    id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
                    invoice_id uuid NOT NULL REFERENCES invoices(id), kind text NOT NULL,
                    status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
                    error text, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
                    UNIQUE(invoice_id,kind)
                );
                CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(company_id,published_at) WHERE status='pending';
                INSERT INTO app_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
                    expires_at timestamptz NOT NULL
                );
                CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
                INSERT INTO app_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
                CREATE TABLE IF NOT EXISTS anaf_connections (
                    company_id uuid PRIMARY KEY REFERENCES companies(id), data jsonb NOT NULL,
                    attempt jsonb
                );
                INSERT INTO app_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
            `);
            await client.query('INSERT INTO workspaces VALUES ($1,$2) ON CONFLICT DO NOTHING', [WORKSPACE, 'My workspace']);
            await client.query(`INSERT INTO companies(id,workspace_id,cif,mode,environment)
                VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [this.companyId, WORKSPACE, this.cfg.cif, this.cfg.mode, this.cfg.environment]);
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async migrateInvoiceTotals(readTotal: (messageId: string) => Promise<string>) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.companyId}:invoice-totals`]);
            const { rows } = await client.query(`SELECT id,message_id FROM invoices
                WHERE company_id=$1 AND data->>'totalBasis' IS DISTINCT FROM 'tax-inclusive'`, [this.companyId]);
            for (const row of rows) {
                const total = await readTotal(row.message_id);
                await client.query(`UPDATE invoices SET data=data || $3::jsonb WHERE id=$1 AND company_id=$2`,
                    [row.id, this.companyId, JSON.stringify({ total, totalBasis: 'tax-inclusive' })]);
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async company(): Promise<Company> {
        const { rows: [r] } = await this.pool.query('SELECT * FROM companies WHERE id=$1 AND workspace_id=$2', [this.companyId, WORKSPACE]);
        return { id: r.id, workspaceId: r.workspace_id, cif: r.cif, mode: r.mode, environment: r.environment,
            pollSeconds: r.poll_seconds, lastSync: r.last_sync?.toISOString() ?? null, nextSync: r.next_sync.toISOString(),
            syncError: r.sync_error, initialized: r.initialized };
    }
    async updatePoll(seconds: number) {
        await this.pool.query("UPDATE companies SET poll_seconds=$2::integer,next_sync=now()+($2::integer * interval '1 second') WHERE id=$1", [this.companyId, seconds]);
    }
    async due() {
        const { rows: [r] } = await this.pool.query('SELECT next_sync<=now() AS due FROM companies WHERE id=$1', [this.companyId]);
        return r.due;
    }
    async finishSync(error?: string) {
        await this.pool.query(`UPDATE companies SET sync_error=$2,
            last_sync=CASE WHEN $2::text IS NULL THEN now() ELSE last_sync END,
            initialized=CASE WHEN $2::text IS NULL THEN true ELSE initialized END,
            next_sync=now()+(poll_seconds * interval '1 second') WHERE id=$1`, [this.companyId, error ?? null]);
    }
    async hasInvoice(id: string) {
        return (await this.pool.query('SELECT 1 FROM invoices WHERE company_id=$1 AND message_id=$2', [this.companyId, id])).rowCount !== 0;
    }
    async insertInvoice(messageId: string, data: InvoiceData, notify: boolean) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const id = randomUUID();
            const result = await client.query(`INSERT INTO invoices(id,company_id,message_id,data)
                VALUES ($1,$2,$3,$4) ON CONFLICT(company_id,message_id) DO NOTHING RETURNING id`, [id, this.companyId, messageId, data]);
            if (result.rowCount) {
                for (const kind of ['invoice.pdf', ...(notify ? ['invoice.email'] : [])]) {
                    await client.query('INSERT INTO outbox(id,company_id,invoice_id,kind) VALUES ($1,$2,$3,$4)', [randomUUID(), this.companyId, id, kind]);
                }
            }
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    private mapInvoice(r: pg.QueryResultRow): Invoice {
        return { ...r.data, id: r.id, messageId: r.message_id, createdAt: r.created_at.toISOString(), pdfReady: r.pdf_ready };
    }
    async invoices(search = '') {
        const result = await this.pool.query(`SELECT * FROM invoices WHERE company_id=$1
            AND (data->>'supplier' ILIKE $2 OR data->>'number' ILIKE $2) ORDER BY created_at DESC LIMIT 200`, [this.companyId, `%${search}%`]);
        return result.rows.map(r => this.mapInvoice(r));
    }
    async invoice(id: string) {
        const { rows: [r] } = await this.pool.query('SELECT * FROM invoices WHERE id=$1 AND company_id=$2', [id, this.companyId]);
        return r ? this.mapInvoice(r) : null;
    }
    async pdfReady(id: string) { await this.pool.query('UPDATE invoices SET pdf_ready=true WHERE id=$1 AND company_id=$2', [id, this.companyId]); }
    private mapEvent(r: pg.QueryResultRow): Event {
        return { id: r.id, companyId: r.company_id, invoiceId: r.invoice_id, kind: r.kind, status: r.status,
            attempts: r.attempts, error: r.error, createdAt: r.created_at.toISOString() };
    }
    async events() {
        const { rows } = await this.pool.query('SELECT * FROM outbox WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100', [this.companyId]);
        return rows.map(r => this.mapEvent(r));
    }
    async pendingEvents() {
        const { rows } = await this.pool.query("SELECT * FROM outbox WHERE company_id=$1 AND published_at IS NULL AND status='pending' ORDER BY created_at LIMIT 100", [this.companyId]);
        return rows.map(r => this.mapEvent(r));
    }
    async event(id: string) {
        const { rows: [r] } = await this.pool.query('SELECT * FROM outbox WHERE id=$1 AND company_id=$2', [id, this.companyId]);
        return r ? this.mapEvent(r) : null;
    }
    async markPublished(id: string) {
        await this.pool.query('UPDATE outbox SET published_at=now() WHERE id=$1 AND company_id=$2', [id, this.companyId]);
    }
    async completeEvent(id: string, skipped = false) {
        await this.pool.query('UPDATE outbox SET status=$3,error=NULL WHERE id=$1 AND company_id=$2', [id, this.companyId, skipped ? 'skipped' : 'sent']);
    }
    async failEvent(id: string, error: string) {
        await this.pool.query(`UPDATE outbox SET attempts=attempts+1,error=$3,
            status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END WHERE id=$1 AND company_id=$2`, [id, this.companyId, error]);
    }
    async replayEvent(id: string) {
        return (await this.pool.query(`UPDATE outbox SET published_at=NULL,status='pending',attempts=0,error=NULL
            WHERE id=$1 AND company_id=$2 AND status IN ('failed','skipped')`, [id, this.companyId])).rowCount === 1;
    }
    async saveSession(tokenHash: string, expiresAt: Date) {
        await this.pool.query('DELETE FROM auth_sessions WHERE workspace_id=$1 AND expires_at<=now()', [WORKSPACE]);
        await this.pool.query('INSERT INTO auth_sessions(token_hash,workspace_id,expires_at) VALUES ($1,$2,$3)', [tokenHash, WORKSPACE, expiresAt]);
    }
    async hasSession(tokenHash: string) {
        return (await this.pool.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND workspace_id=$2 AND expires_at>now()', [tokenHash, WORKSPACE])).rowCount === 1;
    }
    async deleteSession(tokenHash: string) {
        await this.pool.query('DELETE FROM auth_sessions WHERE token_hash=$1 AND workspace_id=$2', [tokenHash, WORKSPACE]);
    }
    async connection(): Promise<ConnectionRecord | null> {
        const { rows: [row] } = await this.pool.query('SELECT data FROM anaf_connections WHERE company_id=$1', [this.companyId]);
        return row?.data ?? null;
    }
    async withConnectionLock<T>(work: (transaction: ConnectionTransaction) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.companyId}:oauth`]);
            const read = async () => (await client.query('SELECT data,attempt FROM anaf_connections WHERE company_id=$1', [this.companyId])).rows[0];
            const result = await work({
                hasSession: async tokenHash => (await client.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND workspace_id=$2 AND expires_at>now()', [tokenHash, WORKSPACE])).rowCount === 1,
                read: async () => (await read())?.data ?? null,
                write: async data => {
                    await client.query(`INSERT INTO anaf_connections(company_id,data) VALUES ($1,$2)
                        ON CONFLICT(company_id) DO UPDATE SET data=EXCLUDED.data`, [this.companyId, data]);
                },
                attempt: async () => (await read())?.attempt as OAuthAttempt ?? null,
                saveAttempt: async attempt => {
                    await client.query(`INSERT INTO anaf_connections(company_id,data,attempt) VALUES ($1,$2,$3)
                        ON CONFLICT(company_id) DO UPDATE SET attempt=EXCLUDED.attempt`, [this.companyId,
                        { state: 'disconnected', encrypted: null, fingerprint: '', connectedAt: null }, attempt]);
                },
                resume: async () => {
                    await client.query('UPDATE companies SET next_sync=now(),sync_error=NULL WHERE id=$1', [this.companyId]);
                    await client.query("UPDATE outbox SET published_at=NULL WHERE company_id=$1 AND kind='invoice.pdf' AND status='pending'", [this.companyId]);
                },
            });
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async close() { await this.pool.end(); }
}
