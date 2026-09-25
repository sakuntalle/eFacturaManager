import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Company, Event, Invoice, InvoicePage, InvoiceSort, SortDirection } from '../../app/contracts.js';
import { mockInvoiceInput } from '../../app/mock/invoice-input.js';
import { ThemeProvider, ThemeSwitch } from './theme.js';
import { InvoiceDetails } from './invoice-details.js';
import { formatAddedDate, formatAppDateTime, formatInvoiceDate } from './invoice-date.js';
import { AnafConnectionCard } from './anaf-connection.js';
import type { ConnectionStatus } from '../../app/contracts.js';
import { connectionFailureMessage } from '../../app/connection-errors.js';
import './style.css';

type Status = { company: Company | null; companies: Company[]; mode: 'mock' | 'live'; emailEnabled: boolean; emailTo: string; connection: ConnectionStatus };
async function api<T>(path: string, body?: unknown, companyId?: string, method?: 'DELETE'): Promise<T> {
    const url = new URL(`/api/${path}`, location.origin);
    if (companyId) url.searchParams.set('companyId', companyId);
    const requestMethod = method ?? (body === undefined ? 'GET' : 'POST');
    const response = await fetch(url, { method: requestMethod,
        headers: requestMethod === 'GET' ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 401) throw new Error('SIGN_IN');
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? 'Request failed. Please try again.');
    }
    return response.json();
}
const date = (value: string | null) => value ? formatAppDateTime(value) : 'Not yet';
type EntityDraft = { name: string; kind: 'company' | 'individual'; cif: string; emailTo: string; emailEnabled: boolean; pollSeconds: number };
function EntityForm({ initial, creating, busy, onSave }: { initial: EntityDraft; creating: boolean; busy: boolean;
    onSave: (value: EntityDraft) => Promise<void> }) {
    const [draft, setDraft] = useState(initial);
    useEffect(() => setDraft(initial), [initial.name, initial.kind, initial.cif, initial.emailTo, initial.emailEnabled, initial.pollSeconds]);
    return <form onSubmit={event => { event.preventDefault(); void onSave(draft); }}>
        <div className="entity-kind-field"><span>Type</span><div className="entity-kind-switch" role="group" aria-label="Entity type">
            {(['company', 'individual'] as const).map(kind => <button key={kind} type="button"
                aria-pressed={draft.kind === kind} disabled={!creating || busy}
                onClick={() => setDraft({ ...draft, kind, cif: '' })}>{kind === 'company' ? 'Company' : 'Individual'}</button>)}
        </div></div>
        <label>{draft.kind === 'individual' ? 'Person name' : 'Company name'}
            <input required maxLength={160} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} disabled={busy} /></label>
        <label>{draft.kind === 'individual' ? 'CNP' : 'CIF / CUI'}
            <input required inputMode="numeric" pattern={draft.kind === 'individual' ? '[0-9]{13}' : '(RO)?[0-9]{1,30}'}
                value={draft.cif} onChange={event => setDraft({ ...draft, cif: event.target.value })} disabled={!creating || busy} /></label>
        <label>Polling interval (seconds)<input type="number" min="15" max="86400" required value={draft.pollSeconds}
            onChange={event => setDraft({ ...draft, pollSeconds: Number(event.target.value) })} disabled={busy} /></label>
        <label>Notification email<input type="email" required maxLength={254} value={draft.emailTo}
            onChange={event => setDraft({ ...draft, emailTo: event.target.value })} disabled={busy} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={draft.emailEnabled}
            onChange={event => setDraft({ ...draft, emailEnabled: event.target.checked })} disabled={busy} />Send invoice emails</label>
        <button className="primary" disabled={busy}>{creating ? 'Add entity' : 'Save entity settings'}</button>
    </form>;
}
function SimulatedInvoiceForm({ companyId, onCancel, onCreated }: { companyId: string; onCancel: () => void; onCreated: (number: string) => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const supplierInput = useRef<HTMLInputElement>(null);
    const submitting = useRef(false);
    const [supplierName, setSupplierName] = useState('');
    const [amountRon, setAmountRon] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        const element = dialog.current!;
        const previousFocus = document.activeElement;
        element.showModal();
        supplierInput.current?.focus();
        return () => {
            element.close();
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, []);
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true); setError('');
        try {
            const input = mockInvoiceInput({ supplierName, amountRon });
            const result = await api<{ created: { number: string } }>('mock', { action: 'invoice', ...input }, companyId);
            onCreated(result.created.number);
        } catch (e) {
            setError(e instanceof Error ? e.message === 'SIGN_IN' ? 'Your session expired. Sign in again to create an invoice.' : e.message : 'Could not create the invoice.');
        } finally { submitting.current = false; setBusy(false); }
    }
    return <dialog ref={dialog} className="invoice-dialog" aria-labelledby="invoice-form-title" onCancel={e => {
        e.preventDefault();
        if (!submitting.current) onCancel();
    }}>
        <form onSubmit={submit}>
            <span className="mode mock">Simulated ANAF data</span>
            <h2 id="invoice-form-title">Create simulated invoice</h2>
            <p>The invoice number is assigned automatically.</p>
            <label>Supplier name<input ref={supplierInput} required maxLength={200} value={supplierName} onChange={e => { setSupplierName(e.target.value); setError(''); }} disabled={busy} /></label>
            <label>Amount (RON)<input required inputMode="decimal" placeholder="e.g. 250,00" value={amountRon} onChange={e => { setAmountRon(e.target.value); setError(''); }} disabled={busy} aria-describedby="invoice-amount-help" /></label>
            <p id="invoice-amount-help" className="muted">Invoice amount, with up to two decimal places. VAT is zero for this simulated invoice.</p>
            {error && <div className="alert error" role="alert">{error}</div>}
            <div className="dialog-actions"><button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
                <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create invoice'}</button></div>
        </form>
    </dialog>;
}
function DeleteEntityDialog({ company, onCancel, onDelete }: { company: Company; onCancel: () => void; onDelete: () => Promise<void> }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        const element = dialog.current!;
        const previousFocus = document.activeElement;
        element.showModal();
        return () => {
            element.close();
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, []);
    async function remove() {
        setBusy(true); setError('');
        try { await onDelete(); }
        catch (error) { setError(error instanceof Error ? error.message : 'Could not delete this entity.'); setBusy(false); }
    }
    return <dialog ref={dialog} className="invoice-dialog" aria-labelledby="delete-entity-title" onCancel={event => {
        event.preventDefault(); if (!busy) onCancel();
    }}>
        <h2 id="delete-entity-title">Delete {company.kind}?</h2>
        <p><strong>{company.name}</strong> and all its stored invoices, ZIPs, PDFs and activity will be permanently deleted.
            The shared ANAF connection and other entities will remain available.</p>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="dialog-actions"><button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="danger" onClick={() => void remove()} disabled={busy}>{busy ? 'Deleting…' : `Delete ${company.kind}`}</button></div>
    </dialog>;
}
function App() {
    const [authenticated, setAuthenticated] = useState<boolean | null>(null);
    const [email, setEmail] = useState('admin@example.test');
    const [password, setPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [companyId, setCompanyId] = useState(() => new URLSearchParams(location.search).get('companyId')
        ?? localStorage.getItem('efactura-company') ?? '');
    const activeCompanyId = useRef(companyId);
    const [showNewEntity, setShowNewEntity] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [invoiceTotal, setInvoiceTotal] = useState(0);
    const [matchingTotal, setMatchingTotal] = useState(0);
    const [page, setPage] = useState(1);
    const activePage = useRef(page);
    const [invoiceSort, setInvoiceSort] = useState<{ by: InvoiceSort; direction: SortDirection }>({ by: 'added', direction: 'desc' });
    const activeInvoiceSort = useRef(invoiceSort);
    const [events, setEvents] = useState<Event[]>([]);
    const [selectedId, setSelectedId] = useState(new URLSearchParams(location.search).get('invoice'));
    const [tab, setTab] = useState('inbox');
    const [search, setSearch] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const activeSearchTerm = useRef(searchTerm);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState(() => {
        const result = new URLSearchParams(location.search).get('anaf');
        return result === 'connected' ? 'ANAF connected. Initial synchronization will start shortly.'
            : result === 'failed' ? connectionFailureMessage(new URLSearchParams(location.search).get('reason')) : '';
    });
    const [skipSetup, setSkipSetup] = useState(false);
    const [busy, setBusy] = useState(false);
    const [scenario, setScenario] = useState('normal');
    const [showInvoiceForm, setShowInvoiceForm] = useState(false);
    const [mockNotice, setMockNotice] = useState('');
    const [mockError, setMockError] = useState('');
    async function load() {
        try {
            const requestedId = activeCompanyId.current;
            const next = await api<Status>('status', undefined, requestedId || undefined);
            if (activeCompanyId.current && next.company?.id !== activeCompanyId.current) return;
            if (!next.company) {
                setStatus(next); setInvoices([]); setInvoiceTotal(0); setMatchingTotal(0);
                setEvents([]); setAuthenticated(true); return;
            }
            const query = new URLSearchParams({ sortBy: invoiceSort.by, direction: invoiceSort.direction,
                page: String(page), search: searchTerm });
            const [result, jobs] = await Promise.all([api<InvoicePage>(`invoices?${query}`, undefined, next.company.id),
                api<Event[]>('events', undefined, next.company.id)]);
            if ((activeCompanyId.current && next.company.id !== activeCompanyId.current)
                || activeInvoiceSort.current.by !== invoiceSort.by || activeInvoiceSort.current.direction !== invoiceSort.direction
                || activePage.current !== page || activeSearchTerm.current !== searchTerm) return;
            setStatus(next); setInvoices(result.items); setInvoiceTotal(result.allTotal); setMatchingTotal(result.total);
            setEvents(jobs); setAuthenticated(true);
            if (!activeCompanyId.current) {
                activeCompanyId.current = next.company.id;
                setCompanyId(next.company.id);
                localStorage.setItem('efactura-company', next.company.id);
            }
            if (next.mode !== 'mock') {
                setTab(current => current === 'mock' ? 'inbox' : current);
                setShowInvoiceForm(false); setMockNotice(''); setMockError('');
            }
            if (next.mode === 'mock') {
                const mock = await api<{ scenario: string }>('mock', undefined, next.company.id); setScenario(mock.scenario);
            }
        } catch (e) {
            if (e instanceof Error && e.message === 'SIGN_IN') setAuthenticated(false);
            else if (e instanceof Error && e.message === 'Entity not found.' && activeCompanyId.current) {
                activeCompanyId.current = ''; setCompanyId(''); localStorage.removeItem('efactura-company');
            }
            else setError(e instanceof Error ? e.message : 'Cannot reach the application.');
        }
    }
    useEffect(() => {
        const url = new URL(location.href);
        if (url.searchParams.has('anaf')) { url.searchParams.delete('anaf'); url.searchParams.delete('reason'); history.replaceState(null, '', url); }
    }, []);
    useEffect(() => {
        if (search === activeSearchTerm.current) return;
        const timer = setTimeout(() => {
            activeSearchTerm.current = search;
            activePage.current = 1;
            setPage(1); setSearchTerm(search); setSelectedId(null);
        }, 250);
        return () => clearTimeout(timer);
    }, [search]);
    useEffect(() => { void load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, [companyId, invoiceSort, page, searchTerm]);
    function sortInvoices(by: InvoiceSort) {
        const next = { by, direction: invoiceSort.by === by && invoiceSort.direction === 'desc' ? 'asc' : 'desc' } as const;
        activeInvoiceSort.current = next;
        activePage.current = 1;
        setPage(1); setInvoiceSort(next); setSelectedId(null);
    }
    function changePage(next: number) {
        activePage.current = next;
        setPage(next); setSelectedId(null);
    }
    async function action(work: () => Promise<unknown>, message: string) {
        setBusy(true); setError(''); setNotice('');
        try { await work(); setNotice(message); await load(); }
        catch (e) { setError(e instanceof Error ? e.message === 'SIGN_IN' ? 'Incorrect email or password, or session expired.' : e.message : 'Request failed.'); }
        finally { setBusy(false); }
    }
    async function simulate(value: string) {
        setBusy(true); setMockError(''); setMockNotice('');
        try {
            await api('mock', { action: 'scenario', value }, status?.company?.id);
            setMockNotice('Simulator scenario updated.'); await load();
        } catch (e) { setMockError(e instanceof Error ? e.message : 'Could not update the simulator.'); }
        finally { setBusy(false); }
    }
    if (authenticated === null && !error) return <div className="loading">Opening your invoice workspace…</div>;
    if (!authenticated) return <main className="login-shell">
        <div className="brand"><span className="brand-icon">eF</span> eFactura <span>Manager</span></div>
        <form className="login-card" onSubmit={e => { e.preventDefault(); void action(async () => {
            await api('login', { email, password, rememberMe }); setPassword(''); setAuthenticated(true);
        }, ''); }}>
            <span className="eyebrow">YOUR INVOICE WORKSPACE</span><h1>Welcome back.</h1>
            <p>Keep track of invoices, downloads and notifications in one place.</p>
            <label>Email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
            <label className="remember-me"><input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} aria-describedby="remember-me-help" />Remember me</label>
            <p id="remember-me-help" className="muted">Stay signed in for 30 days on this browser.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>Sign in →</button>
        </form><p className="login-foot">Self-hosted. Your invoices stay in your workspace.</p>
    </main>;
    if (!status) return <div className="loading">{error || 'Opening your invoice workspace…'}</div>;
    if (!status.company) return <main className="login-shell">
        <div className="brand"><span className="brand-icon">eF</span> eFactura <span>Manager</span></div>
        <div className="login-card"><span className="eyebrow">GET STARTED</span><h1>Add a company or individual</h1>
            <p>Your workspace has no configured entities. Add one to start collecting invoices.</p>
            <EntityForm initial={{ name: '', kind: 'company', cif: '', emailTo: status.emailTo,
                emailEnabled: true, pollSeconds: 60 }} creating busy={busy} onSave={async value => {
                await action(async () => { const created = await api<Company>('companies', value); selectCompany(created.id); }, 'Entity added.');
            }} /></div>
    </main>;
    const currentCompanyId = status.company.id;
    const selected = invoices.find(i => i.id === selectedId);
    function selectCompany(id: string) {
        activeCompanyId.current = id;
        setCompanyId(id);
        if (id) localStorage.setItem('efactura-company', id);
        else localStorage.removeItem('efactura-company');
        activePage.current = 1;
        setPage(1); setSelectedId(null); setInvoices([]); setInvoiceTotal(0); setMatchingTotal(0);
        setEvents([]); setStatus(null); setNotice(''); setError('');
    }
    async function removeCompany(target: Company) {
        const result = await api<{ nextCompanyId: string | null }>(`companies/${target.id}`, undefined, undefined, 'DELETE');
        setDeleteTarget(null);
        selectCompany(result.nextCompanyId ?? '');
        setNotice(`${target.name} was deleted.`);
    }
    const pageCount = Math.max(1, Math.ceil(matchingTotal / 50));
    const connection = status?.connection;
    const needsConnection = status?.mode === 'live' && connection && connection.state !== 'connected';
    const setup = needsConnection && !status.company.initialized && !skipSetup && tab === 'inbox';
    const connectionCard = status?.mode === 'live' && connection && <AnafConnectionCard connection={connection} busy={busy}
        onDisconnect={() => void action(() => api('anaf/disconnect', {}), 'ANAF disconnected for this workspace. Downloaded invoices remain available.')} />;
    const failed = events.filter(e => e.status === 'failed').length;
    return <div className={`shell${tab === 'inbox' && selected ? ' has-details' : ''}`}>
        <aside className="sidebar">
            <div className="brand"><span className="brand-icon">eF</span><div>eFactura<small>MANAGER</small></div></div>
            <div className="workspace-label">WORKSPACE</div>
            {status && <label className="company-switcher">Viewing
                <select aria-label="Viewing company or individual" value={status.company.id} onChange={event => selectCompany(event.target.value)}>
                    {status.companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select></label>}
            {[['inbox', '▤', 'Invoice inbox'], ['activity', '◷', 'Activity'], ['settings', '⚙', 'Settings'], ...(status?.mode === 'mock' ? [['mock', '◇', 'Mocked ANAF']] : [])].map(([id, icon, label]) =>
                <button key={id} className={`nav ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setNotice(''); }}><span>{icon}</span>{label}{id === 'inbox' && <b>{invoiceTotal}</b>}</button>)}
            <div className="sidebar-bottom"><span className="avatar">MY</span><div>{status?.company.name ?? 'Workspace'}
                <small>{status?.company.kind === 'individual' ? 'Individual' : 'Company'}</small></div></div>
            <button className="signout" onClick={() => void action(async () => { await api('logout', {}); setAuthenticated(false); }, '')}>Sign out</button>
        </aside>
        <main className="main">
            <header className="topbar"><span>Workspace <span className="slash">/</span> {tab === 'inbox' ? 'Invoices' : tab === 'activity' ? 'Activity' : tab === 'mock' ? 'Mocked ANAF' : 'Settings'}</span></header>
            <div className="content">
                <section className="heading"><div><span className="eyebrow">{tab === 'inbox' ? 'RECEIVED INVOICES' : 'WORKSPACE'}</span>
                    <h1>{tab === 'inbox' ? 'Your invoice inbox' : tab === 'activity' ? 'Background activity' : tab === 'mock' ? 'Mocked ANAF' : 'Workspace settings'}</h1>
                    <p>{tab === 'inbox' ? 'Automatically collected. Ready when you need them.' : tab === 'activity' ? 'Follow PDF generation and email delivery, including retries.' : tab === 'mock' ? 'Create test invoices, simulate service conditions and check notifications.' : 'Control synchronization and email delivery.'}</p></div>
                    <button className="primary" disabled={busy || !!needsConnection} onClick={() => void action(() => api('sync', {}, status?.company?.id), 'Synchronization queued. The worker will pick it up shortly.')}>↻ Sync now</button>
                </section>
                {error && <div className="alert error" role="alert">{error}</div>}
                {notice && <div className="alert notice" role="status">{notice}</div>}
                {status?.company.syncError && (status.mode !== 'mock' || tab === 'mock') && <div className="alert error">Last sync: {status.company.syncError}</div>}
                {needsConnection && !setup && tab !== 'settings' && <div className="alert notice" role="status">
                    <p>{connection.state === 'reconnect_required' ? 'ANAF authorization needs renewing.' : 'ANAF is not connected.'} Automatic collection is paused. Stored invoices remain available.</p>
                    <button className="secondary" onClick={() => setTab('settings')}>Manage ANAF connection</button>
                </div>}
                {setup && <>{connectionCard}<button className="secondary" onClick={() => setSkipSetup(true)}>View stored invoices</button></>}
                {!setup && <section className="stats">
                    <div><span>Invoices collected</span><strong>{invoiceTotal}</strong></div>
                    <div><span>Last successful sync</span><strong className="small-value">{date(status?.company.lastSync ?? null)}</strong><small>Checks every {status?.company.pollSeconds} seconds</small></div>
                    <div><span>Email notifications</span><strong className="small-value">{status?.emailEnabled ? 'Enabled' : 'Disabled'}</strong><small>{failed ? `${failed} task(s) need attention` : ''}</small></div>
                </section>}
                {tab === 'inbox' && !setup && <section className="card">
                    <div className="card-toolbar"><h2>All received invoices <span className="count">{matchingTotal}</span></h2>
                        <input className="search" placeholder="Search supplier or invoice…" aria-label="Search invoices" value={search} onChange={e => setSearch(e.target.value)} /></div>
                    <div className="table-scroll"><table><thead><tr><th>Supplier / invoice</th>
                        <th aria-sort={invoiceSort.by === 'issue' ? invoiceSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="sort-heading" onClick={() => sortInvoices('issue')}>Issue date <span aria-hidden="true">{invoiceSort.by === 'issue' ? invoiceSort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>
                        <th aria-sort={invoiceSort.by === 'added' ? invoiceSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="sort-heading" onClick={() => sortInvoices('added')}>Added date <span aria-hidden="true">{invoiceSort.by === 'added' ? invoiceSort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>
                        <th>Invoice amount</th><th>Documents</th></tr></thead>
                        <tbody>{invoices.map(i => <tr key={i.id} className={`invoice-row${selectedId === i.id ? ' selected' : ''}`} onClick={event => {
                            if ((event.target as Element).closest('a, button')) return;
                            event.currentTarget.querySelector<HTMLButtonElement>('.invoice-link')?.focus({ preventScroll: true });
                            setSelectedId(i.id);
                        }}>
                            <td><button className="invoice-link" aria-expanded={selectedId === i.id} aria-controls={selectedId === i.id ? 'invoice-details' : undefined} onClick={() => setSelectedId(i.id)}>{i.supplier}<small>{i.number}</small></button></td>
                            <td>{formatInvoiceDate(i.issueDate)}</td><td>{i.addedDate ? formatAddedDate(i.addedDate) : '—'}</td>
                            <td className="amount">{i.total} <span>{i.currency}</span></td>
                            <td><a className="document" href={`/api/invoices/${i.id}/zip?companyId=${currentCompanyId}`}>ZIP ↓</a>{i.pdfReady ? <a className="document" href={`/api/invoices/${i.id}/pdf?companyId=${currentCompanyId}`}>PDF ↓</a> : <span className="muted">Preparing PDF</span>}</td>
                        </tr>)}</tbody></table></div>
                    {!invoices.length && <div className="empty"><h2>{invoiceTotal ? 'No matching invoices' : 'Your inbox is ready'}</h2><p>{invoiceTotal ? 'Try a different supplier or invoice number.' : 'Run a synchronization to collect invoices from ANAF.'}</p></div>}
                    {matchingTotal > 0 && <nav className="pagination" aria-label="Invoice pages">
                        <span>Showing {(page - 1) * 50 + 1}–{Math.min(page * 50, matchingTotal)} of {matchingTotal}</span>
                        <div><button className="secondary" disabled={page === 1} onClick={() => changePage(page - 1)}>Previous</button>
                            <span>Page {page} of {pageCount}</span>
                            <button className="secondary" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>Next</button></div>
                    </nav>}
                </section>}
                {tab === 'activity' && <section className="card"><div className="card-toolbar"><h2>Recent tasks</h2><span className="muted">Automatic retries with backoff</span></div>
                    <div className="table-scroll"><table><thead><tr><th>Task</th><th>Status</th><th>Failed attempts</th><th>Details</th></tr></thead><tbody>{events.map(e => <tr key={e.id}><td>{e.kind === 'invoice.pdf' ? 'Generate PDF' : 'Send invoice email'}<small>{date(e.createdAt)}</small></td>
                        <td><span className={`badge ${e.status}`}>{e.status === 'sent' ? 'Complete' : e.status}</span></td><td>{e.attempts}</td><td>{e.error ?? '—'}{['failed', 'skipped'].includes(e.status) && <button className="document" disabled={busy} onClick={() => void action(() => api(`events/${e.id}/retry`, {}, status?.company?.id), 'Task queued for another attempt.')}>Retry</button>}</td></tr>)}</tbody></table></div>
                    {!events.length && <div className="empty">No background activity yet.</div>}
                </section>}
                {tab === 'settings' && status && <div className="settings-grid">{connectionCard}
                    <section className="card settings-card"><h2>{status.company.name}</h2>
                        <p>Settings for this {status.company.kind}. Invoice data and job history stay separate for each entity.</p>
                        <EntityForm key={status.company.id} initial={{ name: status.company.name, kind: status.company.kind,
                            cif: status.company.cif, emailTo: status.company.emailTo, emailEnabled: status.company.emailEnabled,
                            pollSeconds: status.company.pollSeconds }} busy={busy} creating={false}
                            onSave={value => action(() => api(`companies/${status.company?.id}`, value), 'Entity settings saved.')} />
                        <hr /><button className="danger" disabled={busy} onClick={() => setDeleteTarget(status.company)}>Delete this {status.company.kind}</button>
                    </section>
                    <section className="card settings-card"><h2>Add company or individual</h2>
                        <p>Use the same ANAF certificate connection for another fiscal identifier that it can access.</p>
                        {!showNewEntity ? <button className="secondary" onClick={() => setShowNewEntity(true)}>＋ Add entity</button>
                            : <EntityForm initial={{ name: '', kind: 'company', cif: '', emailTo: status.company.emailTo,
                                emailEnabled: true, pollSeconds: 60 }} busy={busy} creating
                                onSave={async value => { await action(async () => {
                                    const created = await api<Company>('companies', value);
                                    selectCompany(created.id); setShowNewEntity(false);
                                }, 'Entity added. Connect once at workspace level and synchronize this entity.'); }} />}
                    </section>
                    <section className="card settings-card"><h2>Email transport</h2>
                        <p>Outgoing SMTP credentials remain in the server configuration. Each entity has its own notification address above.</p>
                    </section>
                </div>}
                {tab === 'mock' && status?.mode === 'mock' && <>
                    <div className="alert mock-banner"><span className="mode mock">Simulated ANAF data</span><p>This workspace uses test invoices. Email notifications use your configured delivery settings.</p></div>
                    {mockError && <div className="alert error" role="alert">{mockError}</div>}
                    {mockNotice && <div className="alert notice" role="status">{mockNotice}</div>}
                    <div className="settings-grid"><section className="card settings-card"><h2>Try a new invoice</h2><p>Finish the initial sync, then create a new invoice to exercise collection, PDF generation and email delivery.</p>
                    <button className="primary" disabled={busy || !status.company.initialized} onClick={() => setShowInvoiceForm(true)}>＋ Create simulated invoice</button>
                    <hr /><h2>ANAF response scenario</h2><label>Simulate a service condition<select value={scenario} onChange={e => void simulate(e.target.value)} disabled={busy}>
                        {[['normal','Normal operation'],['rate-limit','Rate limited (429)'],['server-error','Service unavailable (503)'],['unauthorized','Authorization expired (401)'],['invalid-zip','Invalid download response'],['pdf-error','PDF conversion unavailable']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}
                    </select></label><p className="muted">Return to normal operation to test recovery.</p></section>
                    <section className="card settings-card"><h2>Mock invoice notifications</h2>
                        <p>{status.emailEnabled ? `Email notifications are enabled for ${status.emailTo}.` : 'Email notifications are disabled.'}</p>
                        <p>New invoices send an email after collection. The initial import does not send individual emails. Subjects begin with [SIMULATED ANAF].</p>
                        <h2>Recent email notifications</h2>
                        <ul className="notification-list">{events.filter(event => event.kind === 'invoice.email').slice(0, 5).map(event => <li key={event.id}>
                            <div><b>{invoices.find(invoice => invoice.id === event.invoiceId)?.number ?? 'Invoice notification'}</b><small>{date(event.createdAt)}</small></div>
                            <span className={`badge ${event.status}`}>{event.status === 'sent' ? 'Sent' : event.status}</span>
                        </li>)}</ul>
                        {!events.some(event => event.kind === 'invoice.email') && <p className="muted">No email notifications yet. Create an invoice after the initial sync to try one.</p>}
                        <button className="secondary" onClick={() => setTab('activity')}>View delivery activity</button>
                    </section></div>
                </>}
                <footer>eFactura Manager · © {new Date().getFullYear()} MD AI RESEARCH SRL <span>Original documents stored in your workspace · {status?.company.environment === 'prod' ? 'Production API environment' : 'ANAF test environment'}</span></footer>
            </div>
        </main>
        {tab === 'inbox' && selected && status && <InvoiceDetails invoice={selected} companyId={status.company.id} onClose={() => setSelectedId(null)} />}
        {showInvoiceForm && status?.mode === 'mock' && <SimulatedInvoiceForm companyId={status.company.id} onCancel={() => setShowInvoiceForm(false)} onCreated={number => {
            setShowInvoiceForm(false); setMockError('');
            setMockNotice(`Simulated invoice ${number} created. Wait for the next poll or choose Sync now.`);
            void load();
        }} />}
        {deleteTarget && <DeleteEntityDialog company={deleteTarget} onCancel={() => setDeleteTarget(null)}
            onDelete={() => removeCompany(deleteTarget)} />}
    </div>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><App /><ThemeSwitch floating /></ThemeProvider>);
