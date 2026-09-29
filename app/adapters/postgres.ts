import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Company, Event, Invoice, InvoiceData, InvoicePage, InvoiceSort, Repository, SessionStore, SortDirection } from '../contracts.js';

import type { ConnectionStore, ConnectionRecord, ConnectionTransaction, OAuthAttempt } from '../connection.js';
import type { EntityInput } from '../entity-input.js';

export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_CONNECTION_ID = '00000000-0000-4000-8000-000000000002';
const WORKSPACE = WORKSPACE_ID;
// PostgreSQL-specific SQL and migrations remain inside this adapter.
export class PostgresRepository implements Repository, SessionStore, ConnectionStore {
    private pool: pg.Pool;
    private companyId: string;
    private cfg: Config;
    private ownsPool: boolean;
    private defaultSelection: boolean;
    private connectionId: string;
    constructor(cfg: Config, companyId?: string, pool?: pg.Pool, connectionId = DEFAULT_CONNECTION_ID) {
        this.cfg = cfg;
        this.pool = pool ?? new pg.Pool({ connectionString: cfg.databaseUrl, max: 6 });
        this.ownsPool = !pool;
        this.defaultSelection = companyId === undefined;
        this.connectionId = connectionId;
        const hex = createHash('sha256').update(`${WORKSPACE}:${cfg.mode}:${cfg.environment}:${cfg.cif}`).digest('hex');
        this.companyId = companyId ?? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }
    forCompany(id: string) { return new PostgresRepository(this.cfg, id, this.pool, this.connectionId); }
    forConnection(id: string) { return new PostgresRepository(this.cfg, this.companyId, this.pool, id); }
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
                CREATE TABLE IF NOT EXISTS invoice_files (
                    company_id uuid NOT NULL REFERENCES companies(id),
                    message_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('zip','pdf')),
                    data bytea NOT NULL, sha256 text NOT NULL,
                    PRIMARY KEY(company_id,message_id,kind)
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
                CREATE TABLE IF NOT EXISTS admin_accounts (
                    username text PRIMARY KEY CHECK (username='admin'),
                    password_hash text NOT NULL, must_change_password boolean NOT NULL DEFAULT true
                );
                INSERT INTO app_migrations(version) VALUES (6) ON CONFLICT DO NOTHING;
                CREATE TABLE IF NOT EXISTS anaf_connections (
                    company_id uuid PRIMARY KEY REFERENCES companies(id), data jsonb NOT NULL,
                    attempt jsonb
                );
                CREATE TABLE IF NOT EXISTS workspace_connections (
                    workspace_id uuid NOT NULL REFERENCES workspaces(id), mode text NOT NULL,
                    environment text NOT NULL, data jsonb NOT NULL, attempt jsonb,
                    PRIMARY KEY(workspace_id,mode,environment)
                );
                CREATE TABLE IF NOT EXISTS managed_connections (
                    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
                    mode text NOT NULL, environment text NOT NULL, name text NOT NULL,
                    verification_cif text, data jsonb NOT NULL, attempt jsonb,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE TABLE IF NOT EXISTS entity_bootstrap (
                    workspace_id uuid NOT NULL REFERENCES workspaces(id), mode text NOT NULL,
                    environment text NOT NULL, PRIMARY KEY(workspace_id,mode,environment)
                );
                INSERT INTO app_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS name text;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'company';
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_to text;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_enabled boolean;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS added_date_backfilled boolean NOT NULL DEFAULT false;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS added_time_backfilled boolean NOT NULL DEFAULT false;
                ALTER TABLE companies ADD COLUMN IF NOT EXISTS connection_id uuid;
                ALTER TABLE invoices ADD COLUMN IF NOT EXISTS added_date text;
            `);
            await client.query(`UPDATE companies SET name=COALESCE(name, 'Company ' || cif),
                email_to=COALESCE(email_to, $1), email_enabled=COALESCE(email_enabled, $2)
                WHERE workspace_id=$3`, [this.cfg.smtp.to, this.cfg.emailEnabled, WORKSPACE]);
            if ((await client.query('SELECT 1 FROM app_migrations WHERE version=4')).rowCount === 0) {
                await client.query("UPDATE outbox SET published_at=NULL WHERE status='pending'");
                await client.query('INSERT INTO app_migrations(version) VALUES (4)');
            }
            await client.query('INSERT INTO workspaces VALUES ($1,$2) ON CONFLICT DO NOTHING', [WORKSPACE, 'My workspace']);
            await client.query(`INSERT INTO workspace_connections(workspace_id,mode,environment,data,attempt)
                SELECT DISTINCT ON (c.workspace_id,c.mode,c.environment)
                    c.workspace_id,c.mode,c.environment,a.data,a.attempt
                FROM anaf_connections a JOIN companies c ON c.id=a.company_id
                ORDER BY c.workspace_id,c.mode,c.environment,c.id
                ON CONFLICT(workspace_id,mode,environment) DO NOTHING`);
            await client.query('DROP TABLE anaf_connections');
            await client.query(`INSERT INTO managed_connections
                (id,workspace_id,mode,environment,name,verification_cif,data,attempt)
                SELECT $1,$2,$3,$4,'Primary ANAF connection',$5,
                    COALESCE(w.data,$6::jsonb),w.attempt
                FROM workspaces s LEFT JOIN workspace_connections w ON w.workspace_id=s.id
                    AND w.mode=$3 AND w.environment=$4
                WHERE s.id=$2 AND (w.workspace_id IS NOT NULL OR EXISTS (
                    SELECT 1 FROM companies c WHERE c.workspace_id=$2 AND c.mode=$3 AND c.environment=$4
                )) ON CONFLICT(id) DO NOTHING`,
            [DEFAULT_CONNECTION_ID, WORKSPACE, this.cfg.mode, this.cfg.environment, this.cfg.cif,
                JSON.stringify({ state: 'disconnected', encrypted: null, fingerprint: '', connectedAt: null })]);
            await client.query('UPDATE companies SET connection_id=$1 WHERE workspace_id=$2 AND connection_id IS NULL',
                [DEFAULT_CONNECTION_ID, WORKSPACE]);
            await client.query(`DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companies_connection_id_fkey') THEN
                    ALTER TABLE companies ADD CONSTRAINT companies_connection_id_fkey
                        FOREIGN KEY (connection_id) REFERENCES managed_connections(id);
                END IF;
            END $$`);
            await client.query('CREATE INDEX IF NOT EXISTS companies_connection_id_idx ON companies(connection_id)');
            await client.query('INSERT INTO app_migrations(version) VALUES (7) ON CONFLICT DO NOTHING');
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async migrateLegacyFiles(readLegacy: (company: { mode: Config['mode']; environment: Config['environment']; cif: string },
        messageId: string, kind: 'zip' | 'pdf') => Promise<Buffer>) {
        const client = await this.pool.connect();
        let locked = false;
        try {
            await client.query('SELECT pg_advisory_lock(81392003)');
            locked = true;
            const completed = (await client.query('SELECT 1 FROM app_migrations WHERE version=5')).rowCount !== 0;
            const { rows } = await client.query(`SELECT c.id,c.mode,c.environment,c.cif,i.message_id,i.pdf_ready
                FROM invoices i JOIN companies c ON c.id=i.company_id
                WHERE c.workspace_id=$1 AND ($2::boolean=false OR NOT EXISTS (
                    SELECT 1 FROM invoice_files f WHERE f.company_id=c.id AND f.message_id=i.message_id AND f.kind='zip'
                ) OR (i.pdf_ready AND NOT EXISTS (
                    SELECT 1 FROM invoice_files f WHERE f.company_id=c.id AND f.message_id=i.message_id AND f.kind='pdf'
                )))`, [WORKSPACE, completed]);
            for (const row of rows) {
                const kinds: ('zip' | 'pdf')[] = row.pdf_ready ? ['zip', 'pdf'] : ['zip'];
                for (const kind of kinds) {
                    const existing = await client.query(`SELECT data,sha256 FROM invoice_files
                        WHERE company_id=$1 AND message_id=$2 AND kind=$3`, [row.id, row.message_id, kind]);
                    if (existing.rowCount) {
                        const stored = existing.rows[0];
                        if (createHash('sha256').update(stored.data).digest('hex') !== stored.sha256) {
                            throw new Error('A stored invoice document failed integrity verification.');
                        }
                        continue;
                    }
                    const bytes = await readLegacy(row, row.message_id, kind);
                    const hash = createHash('sha256').update(bytes).digest('hex');
                    await client.query(`INSERT INTO invoice_files(company_id,message_id,kind,data,sha256)
                        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                    [row.id, row.message_id, kind, bytes, hash]);
                    const { rows: [stored] } = await client.query(`SELECT data,sha256 FROM invoice_files
                        WHERE company_id=$1 AND message_id=$2 AND kind=$3`, [row.id, row.message_id, kind]);
                    if (stored.sha256 !== hash || createHash('sha256').update(stored.data).digest('hex') !== hash) {
                        throw new Error('A migrated invoice document failed integrity verification.');
                    }
                }
            }
            await client.query('INSERT INTO app_migrations(version) VALUES (5) ON CONFLICT DO NOTHING');
        } finally {
            if (locked) await client.query('SELECT pg_advisory_unlock(81392003)');
            client.release();
        }
    }
    async putFile(messageId: string, kind: 'zip' | 'pdf', data: Uint8Array) {
        const bytes = Buffer.from(data);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (!(await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [this.companyId])).rowCount) {
                throw new Error('Entity no longer exists.');
            }
            await client.query(`INSERT INTO invoice_files(company_id,message_id,kind,data,sha256)
                VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [this.companyId, messageId, kind, bytes, hash]);
            const { rows: [stored] } = await client.query(`SELECT data,sha256 FROM invoice_files
                WHERE company_id=$1 AND message_id=$2 AND kind=$3`, [this.companyId, messageId, kind]);
            if (createHash('sha256').update(stored.data).digest('hex') !== stored.sha256) {
                throw new Error('Stored invoice document failed integrity verification.');
            }
            if (kind === 'zip' && stored.sha256 !== hash) throw new Error('The original invoice ZIP differs from the stored copy.');
            await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async readFile(messageId: string, kind: 'zip' | 'pdf'): Promise<Buffer> {
        const { rows: [stored] } = await this.pool.query(`SELECT data,sha256 FROM invoice_files
            WHERE company_id=$1 AND message_id=$2 AND kind=$3`, [this.companyId, messageId, kind]);
        if (!stored) throw new Error('Stored invoice document is unavailable.');
        if (createHash('sha256').update(stored.data).digest('hex') !== stored.sha256) {
            throw new Error('Stored invoice document failed integrity verification.');
        }
        return stored.data;
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
        const { rows: [r] } = this.defaultSelection
            ? await this.pool.query(`SELECT * FROM companies WHERE workspace_id=$1 AND mode=$2 AND environment=$3
                ORDER BY (id=$4) DESC,name,id LIMIT 1`, [WORKSPACE, this.cfg.mode, this.cfg.environment, this.companyId])
            : await this.pool.query('SELECT * FROM companies WHERE id=$1 AND workspace_id=$2 AND mode=$3 AND environment=$4',
                [this.companyId, WORKSPACE, this.cfg.mode, this.cfg.environment]);
        if (!r) throw new Error('Company does not exist.');
        return this.mapCompany(r);
    }
    private mapCompany(r: pg.QueryResultRow): Company {
        return { id: r.id, workspaceId: r.workspace_id, cif: r.cif, name: r.name, kind: r.kind,
            connectionId: r.connection_id ?? DEFAULT_CONNECTION_ID,
            emailTo: r.email_to, emailEnabled: r.email_enabled, mode: r.mode, environment: r.environment,
            pollSeconds: r.poll_seconds, lastSync: r.last_sync?.toISOString() ?? null, nextSync: r.next_sync.toISOString(),
            syncError: r.sync_error, initialized: r.initialized };
    }
    async companies(): Promise<Company[]> {
        const { rows } = await this.pool.query(`SELECT * FROM companies WHERE workspace_id=$1 AND mode=$2 AND environment=$3
            ORDER BY name, id`, [WORKSPACE, this.cfg.mode, this.cfg.environment]);
        return rows.map(r => this.mapCompany(r));
    }
    async findCompany(id: string): Promise<Company | null> {
        const { rows: [r] } = await this.pool.query(`SELECT * FROM companies WHERE id=$1 AND workspace_id=$2
            AND mode=$3 AND environment=$4`, [id, WORKSPACE, this.cfg.mode, this.cfg.environment]);
        return r ? this.mapCompany(r) : null;
    }
    async managedConnections(): Promise<{ id: string; name: string; verificationCif: string | null; entityIds: string[] }[]> {
        const { rows } = await this.pool.query(`SELECT m.id,m.name,m.verification_cif,
            COALESCE(array_agg(c.id ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),ARRAY[]::uuid[]) AS entity_ids
            FROM managed_connections m LEFT JOIN companies c ON c.connection_id=m.id
            WHERE m.workspace_id=$1 AND m.mode=$2 AND m.environment=$3
            GROUP BY m.id ORDER BY m.created_at,m.id`, [WORKSPACE, this.cfg.mode, this.cfg.environment]);
        return rows.map(r => ({ id: r.id, name: r.name, verificationCif: r.verification_cif, entityIds: r.entity_ids }));
    }
    async managedConnection(id: string): Promise<{ id: string; name: string; verificationCif: string | null } | null> {
        const { rows: [r] } = await this.pool.query(`SELECT id,name,verification_cif FROM managed_connections
            WHERE id=$1 AND workspace_id=$2 AND mode=$3 AND environment=$4`,
        [id, WORKSPACE, this.cfg.mode, this.cfg.environment]);
        return r ? { id: r.id, name: r.name, verificationCif: r.verification_cif } : null;
    }
    async createManagedConnection(name: string) {
        const id = randomUUID();
        await this.pool.query(`INSERT INTO managed_connections
            (id,workspace_id,mode,environment,name,data) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, WORKSPACE, this.cfg.mode, this.cfg.environment, name,
            { state: 'disconnected', encrypted: null, fingerprint: '', connectedAt: null }]);
        return { id, name, verificationCif: null, entityIds: [] as string[] };
    }
    async createCompany(input: EntityInput, connectionId = DEFAULT_CONNECTION_ID): Promise<Company> {
        const client = await this.pool.connect();
        const id = randomUUID();
        try {
            await client.query('BEGIN');
            if (!(await client.query(`SELECT id FROM managed_connections WHERE id=$1 AND workspace_id=$2
                AND mode=$3 AND environment=$4 FOR UPDATE`,
            [connectionId, WORKSPACE, this.cfg.mode, this.cfg.environment])).rowCount) {
                throw new Error('ANAF connection does not exist.');
            }
            const { rows: [r] } = await client.query(`INSERT INTO companies
                (id,workspace_id,cif,mode,environment,name,kind,email_to,email_enabled,poll_seconds,connection_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [id, WORKSPACE, input.cif, this.cfg.mode, this.cfg.environment, input.name, input.kind,
                input.emailTo, input.emailEnabled, input.pollSeconds, connectionId]);
            await client.query('UPDATE managed_connections SET verification_cif=$2 WHERE id=$1 AND verification_cif IS NULL',
            [connectionId, input.cif]);
            await client.query('COMMIT');
            return this.mapCompany(r);
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async updateCompany(input: EntityInput, connectionId = DEFAULT_CONNECTION_ID): Promise<Company> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (!(await client.query(`SELECT id FROM managed_connections WHERE id=$1 AND workspace_id=$2
                AND mode=$3 AND environment=$4 FOR UPDATE`,
            [connectionId, WORKSPACE, this.cfg.mode, this.cfg.environment])).rowCount) {
                throw new Error('ANAF connection does not exist.');
            }
            const { rows: [r] } = await client.query(`UPDATE companies SET name=$2,kind=$3,email_to=$4,
                email_enabled=$5,poll_seconds=$6,next_sync=now(),connection_id=$11 WHERE id=$1 AND workspace_id=$7
                AND mode=$8 AND environment=$9 AND cif=$10 RETURNING *`,
            [this.companyId, input.name, input.kind, input.emailTo, input.emailEnabled,
                input.pollSeconds, WORKSPACE, this.cfg.mode, this.cfg.environment, input.cif, connectionId]);
            if (!r) throw new Error('Company does not exist or fiscal identifier cannot be changed.');
            await client.query('UPDATE managed_connections SET verification_cif=$2 WHERE id=$1 AND verification_cif IS NULL',
            [connectionId, input.cif]);
            await client.query('COMMIT');
            return this.mapCompany(r);
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async deleteCompany(id: string): Promise<{ deleted: boolean; nextCompanyId: string | null }> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [WORKSPACE]);
            const selected = await client.query(`SELECT id FROM companies WHERE id=$1 AND workspace_id=$2
                AND mode=$3 AND environment=$4 FOR UPDATE`, [id, WORKSPACE, this.cfg.mode, this.cfg.environment]);
            if (!selected.rowCount) {
                await client.query('ROLLBACK');
                return { deleted: false, nextCompanyId: null };
            }
            await client.query('DELETE FROM outbox WHERE company_id=$1', [id]);
            await client.query('DELETE FROM invoice_files WHERE company_id=$1', [id]);
            await client.query('DELETE FROM invoices WHERE company_id=$1', [id]);
            await client.query('DELETE FROM companies WHERE id=$1', [id]);
            const { rows: [next] } = await client.query(`SELECT id FROM companies WHERE workspace_id=$1
                AND mode=$2 AND environment=$3 ORDER BY name,id LIMIT 1`,
            [WORKSPACE, this.cfg.mode, this.cfg.environment]);
            await client.query('COMMIT');
            return { deleted: true, nextCompanyId: next?.id ?? null };
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
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
    async addedDateBackfillPending() {
        const { rows: [row] } = await this.pool.query(`SELECT NOT (added_date_backfilled AND added_time_backfilled) AS pending
            FROM companies WHERE id=$1`, [this.companyId]);
        return row.pending as boolean;
    }
    async markAddedDateBackfilled() {
        await this.pool.query('UPDATE companies SET added_date_backfilled=true,added_time_backfilled=true WHERE id=$1', [this.companyId]);
    }
    async updateInvoiceAddedDate(messageId: string, addedDate: string | null) {
        if (!addedDate) return;
        await this.pool.query(`UPDATE invoices SET added_date=$3 WHERE company_id=$1 AND message_id=$2
            AND (added_date IS NULL OR length(added_date)=10)`, [this.companyId, messageId, addedDate]);
    }
    async insertInvoice(messageId: string, data: InvoiceData, notify: boolean, addedDate: string | null = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (!(await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [this.companyId])).rowCount) {
                throw new Error('Entity no longer exists.');
            }
            const id = randomUUID();
            const result = await client.query(`INSERT INTO invoices(id,company_id,message_id,data,added_date)
                VALUES ($1,$2,$3,$4,$5) ON CONFLICT(company_id,message_id) DO NOTHING RETURNING id`,
            [id, this.companyId, messageId, data, addedDate]);
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
        return { ...r.data, id: r.id, messageId: r.message_id, createdAt: r.created_at.toISOString(),
            addedDate: r.added_date ?? null, pdfReady: r.pdf_ready };
    }
    private invoiceOrder(sortBy: InvoiceSort, direction: SortDirection) {
        const directionSql = direction === 'asc' ? 'ASC' : 'DESC';
        return sortBy === 'issue' ? `data->>'issueDate' ${directionSql} NULLS LAST,
            added_date DESC NULLS LAST, created_at DESC, id DESC`
            : `added_date ${directionSql} NULLS LAST,
                data->>'issueDate' DESC NULLS LAST, created_at DESC, id DESC`;
    }
    async invoices(search = '', sortBy: InvoiceSort = 'added', direction: SortDirection = 'desc') {
        const result = await this.pool.query(`SELECT * FROM invoices WHERE company_id=$1
            AND (data->>'supplier' ILIKE $2 OR data->>'number' ILIKE $2)
            ORDER BY ${this.invoiceOrder(sortBy, direction)}`,
        [this.companyId, `%${search}%`]);
        return result.rows.map(r => this.mapInvoice(r));
    }
    async invoicePage(search: string, sortBy: InvoiceSort, direction: SortDirection, page: number, pageSize: number): Promise<InvoicePage> {
        const pattern = `%${search}%`;
        const { rows: [counts] } = await this.pool.query(`SELECT count(*)::integer AS all_total,
            count(*) FILTER (WHERE data->>'supplier' ILIKE $2 OR data->>'number' ILIKE $2)::integer AS total
            FROM invoices WHERE company_id=$1`, [this.companyId, pattern]);
        const { rows } = await this.pool.query(`SELECT * FROM invoices WHERE company_id=$1
            AND (data->>'supplier' ILIKE $2 OR data->>'number' ILIKE $2)
            ORDER BY ${this.invoiceOrder(sortBy, direction)} LIMIT $3 OFFSET $4`,
        [this.companyId, pattern, pageSize, (page - 1) * pageSize]);
        return { items: rows.map(r => this.mapInvoice(r)), total: counts.total, allTotal: counts.all_total, page, pageSize };
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
    async adminAccount(): Promise<{ passwordHash: string; mustChangePassword: boolean } | null> {
        const { rows: [row] } = await this.pool.query(`SELECT password_hash,must_change_password
            FROM admin_accounts WHERE username='admin'`);
        return row ? { passwordHash: row.password_hash, mustChangePassword: row.must_change_password } : null;
    }
    async createAdmin(passwordHash: string) {
        return (await this.pool.query(`INSERT INTO admin_accounts(username,password_hash)
            VALUES ('admin',$1) ON CONFLICT DO NOTHING`, [passwordHash])).rowCount === 1;
    }
    async changeAdminPassword(previousHash: string, nextHash: string) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(`UPDATE admin_accounts SET password_hash=$2,must_change_password=false
                WHERE username='admin' AND password_hash=$1`, [previousHash, nextHash]);
            if (result.rowCount !== 1) {
                await client.query('ROLLBACK');
                return false;
            }
            await client.query('DELETE FROM auth_sessions WHERE workspace_id=$1', [WORKSPACE]);
            await client.query('UPDATE workspace_connections SET attempt=NULL WHERE workspace_id=$1', [WORKSPACE]);
            await client.query('UPDATE managed_connections SET attempt=NULL WHERE workspace_id=$1', [WORKSPACE]);
            await client.query('COMMIT');
            return true;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
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
        const { rows: [row] } = await this.pool.query(`SELECT data FROM managed_connections
            WHERE id=$1 AND workspace_id=$2 AND mode=$3 AND environment=$4`,
        [this.connectionId, WORKSPACE, this.cfg.mode, this.cfg.environment]);
        return row?.data ?? null;
    }
    async withConnectionLock<T>(work: (transaction: ConnectionTransaction) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.connectionId}:oauth`]);
            const read = async () => (await client.query(`SELECT data,attempt FROM managed_connections
                WHERE id=$1 AND workspace_id=$2 AND mode=$3 AND environment=$4`,
            [this.connectionId, WORKSPACE, this.cfg.mode, this.cfg.environment])).rows[0];
            const result = await work({
                hasSession: async tokenHash => (await client.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND workspace_id=$2 AND expires_at>now()', [tokenHash, WORKSPACE])).rowCount === 1,
                read: async () => (await read())?.data ?? null,
                write: async data => {
                    await client.query('UPDATE managed_connections SET data=$2 WHERE id=$1', [this.connectionId, data]);
                },
                attempt: async () => (await read())?.attempt as OAuthAttempt ?? null,
                saveAttempt: async attempt => {
                    await client.query('UPDATE managed_connections SET attempt=$2 WHERE id=$1', [this.connectionId, attempt]);
                },
                resume: async () => {
                    await client.query(`UPDATE companies SET next_sync=now(),sync_error=NULL
                        WHERE connection_id=$1 AND workspace_id=$2 AND mode=$3 AND environment=$4`,
                    [this.connectionId, WORKSPACE, this.cfg.mode, this.cfg.environment]);
                    await client.query(`UPDATE outbox SET published_at=NULL WHERE kind='invoice.pdf' AND status='pending'
                        AND company_id IN (SELECT id FROM companies WHERE connection_id=$1 AND workspace_id=$2
                            AND mode=$3 AND environment=$4)`,
                    [this.connectionId, WORKSPACE, this.cfg.mode, this.cfg.environment]);
                },
            });
            await client.query('COMMIT');
            return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async close() { if (this.ownsPool) await this.pool.end(); }
}
