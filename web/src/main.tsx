import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Company, Event, Invoice } from '../../app/contracts.js';
import { mockInvoiceInput } from '../../app/mock/invoice-input.js';
import { ThemeProvider, ThemeSwitch } from './theme.js';
import { InvoiceDetails } from './invoice-details.js';
import { AnafConnectionCard } from './anaf-connection.js';
import type { ConnectionStatus } from '../../app/contracts.js';
import { connectionFailureMessage } from '../../app/connection-errors.js';
import './style.css';

type Status = { company: Company; mode: 'mock' | 'live'; emailEnabled: boolean; emailTo: string; connection: ConnectionStatus };
async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status === 401) throw new Error('SIGN_IN');
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? 'Request failed. Please try again.');
    }
    return response.json();
}
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet';
function SimulatedInvoiceForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (number: string) => void }) {
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
            const result = await api<{ created: { number: string } }>('mock', { action: 'invoice', ...input });
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
function App() {
    const [authenticated, setAuthenticated] = useState<boolean | null>(null);
    const [email, setEmail] = useState('admin@example.test');
    const [password, setPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [events, setEvents] = useState<Event[]>([]);
    const [selectedId, setSelectedId] = useState(new URLSearchParams(location.search).get('invoice'));
    const [tab, setTab] = useState('inbox');
    const [search, setSearch] = useState('');
    const [poll, setPoll] = useState(60);
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
            const [next, rows, jobs] = await Promise.all([api<Status>('status'), api<Invoice[]>('invoices'), api<Event[]>('events')]);
            setStatus(next); setInvoices(rows); setEvents(jobs); setAuthenticated(true);
            if (next.mode !== 'mock') {
                setTab(current => current === 'mock' ? 'inbox' : current);
                setShowInvoiceForm(false); setMockNotice(''); setMockError('');
            }
            if (next.mode === 'mock') {
                const mock = await api<{ scenario: string }>('mock'); setScenario(mock.scenario);
            }
        } catch (e) {
            if (e instanceof Error && e.message === 'SIGN_IN') setAuthenticated(false);
            else setError(e instanceof Error ? e.message : 'Cannot reach the application.');
        }
    }
    useEffect(() => {
        const url = new URL(location.href);
        if (url.searchParams.has('anaf')) { url.searchParams.delete('anaf'); url.searchParams.delete('reason'); history.replaceState(null, '', url); }
    }, []);
    useEffect(() => { void load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, []);
    useEffect(() => { if (status) setPoll(status.company.pollSeconds); }, [status?.company.pollSeconds]);
    async function action(work: () => Promise<unknown>, message: string) {
        setBusy(true); setError(''); setNotice('');
        try { await work(); setNotice(message); await load(); }
        catch (e) { setError(e instanceof Error ? e.message === 'SIGN_IN' ? 'Incorrect email or password, or session expired.' : e.message : 'Request failed.'); }
        finally { setBusy(false); }
    }
    async function simulate(value: string) {
        setBusy(true); setMockError(''); setMockNotice('');
        try {
            await api('mock', { action: 'scenario', value });
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
    const selected = invoices.find(i => i.id === selectedId);
    const visible = invoices.filter(i => `${i.number} ${i.supplier}`.toLowerCase().includes(search.toLowerCase()));
    const connection = status?.connection;
    const needsConnection = status?.mode === 'live' && connection && connection.state !== 'connected';
    const setup = needsConnection && !status.company.initialized && !skipSetup && tab === 'inbox';
    const connectionCard = status?.mode === 'live' && connection && <AnafConnectionCard connection={connection} cif={status.company.cif} busy={busy}
        onDisconnect={() => void action(() => api('anaf/disconnect', {}), 'ANAF disconnected. Your downloaded invoices remain available.')} />;
    const failed = events.filter(e => e.status === 'failed').length;
    return <div className={`shell${tab === 'inbox' && selected ? ' has-details' : ''}`}>
        <aside className="sidebar">
            <div className="brand"><span className="brand-icon">eF</span><div>eFactura<small>MANAGER</small></div></div>
            <div className="workspace-label">WORKSPACE</div>
            {[['inbox', '▤', 'Invoice inbox'], ['activity', '◷', 'Activity'], ['settings', '⚙', 'Settings'], ...(status?.mode === 'mock' ? [['mock', '◇', 'Mocked ANAF']] : [])].map(([id, icon, label]) =>
                <button key={id} className={`nav ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setNotice(''); }}><span>{icon}</span>{label}{id === 'inbox' && <b>{invoices.length}</b>}</button>)}
            <div className="sidebar-bottom"><span className="avatar">MY</span><div>My company<small>CIF {status?.company.cif}</small></div></div>
            <button className="signout" onClick={() => void action(async () => { await api('logout', {}); setAuthenticated(false); }, '')}>Sign out</button>
        </aside>
        <main className="main">
            <header className="topbar"><span>Workspace <span className="slash">/</span> {tab === 'inbox' ? 'Invoices' : tab === 'activity' ? 'Activity' : tab === 'mock' ? 'Mocked ANAF' : 'Settings'}</span></header>
            <div className="content">
                <section className="heading"><div><span className="eyebrow">{tab === 'inbox' ? 'RECEIVED INVOICES' : 'WORKSPACE'}</span>
                    <h1>{tab === 'inbox' ? 'Your invoice inbox' : tab === 'activity' ? 'Background activity' : tab === 'mock' ? 'Mocked ANAF' : 'Workspace settings'}</h1>
                    <p>{tab === 'inbox' ? 'Automatically collected. Ready when you need them.' : tab === 'activity' ? 'Follow PDF generation and email delivery, including retries.' : tab === 'mock' ? 'Create test invoices, simulate service conditions and check notifications.' : 'Control synchronization and email delivery.'}</p></div>
                    <button className="primary" disabled={busy || !!needsConnection} onClick={() => void action(() => api('sync', {}), 'Synchronization queued. The worker will pick it up shortly.')}>↻ Sync now</button>
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
                    <div><span>Invoices collected</span><strong>{invoices.length}</strong><small>Most recent 200 shown</small></div>
                    <div><span>Last successful sync</span><strong className="small-value">{date(status?.company.lastSync ?? null)}</strong><small>Checks every {status?.company.pollSeconds} seconds</small></div>
                    <div><span>Email notifications</span><strong className="small-value">{status?.emailEnabled ? 'Enabled' : 'Disabled'}</strong><small>{failed ? `${failed} task(s) need attention` : 'Initial import does not send individual emails'}</small></div>
                </section>}
                {tab === 'inbox' && !setup && <section className="card">
                    <div className="card-toolbar"><h2>All received invoices <span className="count">{visible.length}</span></h2>
                        <input className="search" placeholder="Search supplier or invoice…" aria-label="Search invoices" value={search} onChange={e => setSearch(e.target.value)} /></div>
                    <div className="table-scroll"><table><thead><tr><th>Supplier / invoice</th><th>Issue date</th><th>Invoice amount</th><th>Documents</th></tr></thead>
                        <tbody>{visible.map(i => <tr key={i.id} className={`invoice-row${selectedId === i.id ? ' selected' : ''}`} onClick={event => {
                            if ((event.target as Element).closest('a, button')) return;
                            event.currentTarget.querySelector<HTMLButtonElement>('.invoice-link')?.focus({ preventScroll: true });
                            setSelectedId(i.id);
                        }}>
                            <td><button className="invoice-link" aria-expanded={selectedId === i.id} aria-controls={selectedId === i.id ? 'invoice-details' : undefined} onClick={() => setSelectedId(i.id)}>{i.supplier}<small>{i.number}</small></button></td>
                            <td>{i.issueDate}</td><td className="amount">{i.total} <span>{i.currency}</span></td>
                            <td><a className="document" href={`/api/invoices/${i.id}/zip`}>ZIP ↓</a>{i.pdfReady ? <a className="document" href={`/api/invoices/${i.id}/pdf`}>PDF ↓</a> : <span className="muted">Preparing PDF</span>}</td>
                        </tr>)}</tbody></table></div>
                    {!visible.length && <div className="empty"><h2>{invoices.length ? 'No matching invoices' : 'Your inbox is ready'}</h2><p>{invoices.length ? 'Try a different supplier or invoice number.' : 'Run a synchronization to collect invoices from ANAF.'}</p></div>}
                </section>}
                {tab === 'activity' && <section className="card"><div className="card-toolbar"><h2>Recent tasks</h2><span className="muted">Automatic retries with backoff</span></div>
                    <div className="table-scroll"><table><thead><tr><th>Task</th><th>Status</th><th>Failed attempts</th><th>Details</th></tr></thead><tbody>{events.map(e => <tr key={e.id}><td>{e.kind === 'invoice.pdf' ? 'Generate PDF' : 'Send invoice email'}<small>{date(e.createdAt)}</small></td>
                        <td><span className={`badge ${e.status}`}>{e.status === 'sent' ? 'Complete' : e.status}</span></td><td>{e.attempts}</td><td>{e.error ?? '—'}{['failed', 'skipped'].includes(e.status) && <button className="document" disabled={busy} onClick={() => void action(() => api(`events/${e.id}/retry`, {}), 'Task queued for another attempt.')}>Retry</button>}</td></tr>)}</tbody></table></div>
                    {!events.length && <div className="empty">No background activity yet.</div>}
                </section>}
                {tab === 'settings' && <div className="settings-grid">{connectionCard}<section className="card settings-card"><h2>Synchronization</h2><p>Keep collecting invoices while the worker is running.</p>
                    <form onSubmit={e => { e.preventDefault(); void action(() => api('settings', { pollSeconds: poll }), 'Polling interval saved.'); }}>
                        <label>Polling interval (seconds)<input type="number" min="15" max="86400" value={poll} onChange={e => setPoll(Number(e.target.value))} required /></label><button className="primary" disabled={busy}>Save interval</button>
                    </form></section><section className="card settings-card"><h2>Email delivery</h2><p>{status?.emailEnabled ? `Sending via configured SMTP to ${status.emailTo}.` : 'Email is disabled in deployment configuration.'}</p><p className="muted">Delivery settings are managed in the deployment configuration.</p>
                </section></div>}
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
        {tab === 'inbox' && selected && <InvoiceDetails invoice={selected} onClose={() => setSelectedId(null)} />}
        {showInvoiceForm && status?.mode === 'mock' && <SimulatedInvoiceForm onCancel={() => setShowInvoiceForm(false)} onCreated={number => {
            setShowInvoiceForm(false); setMockError('');
            setMockNotice(`Simulated invoice ${number} created. Wait for the next poll or choose Sync now.`);
            void load();
        }} />}
    </div>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><App /><ThemeSwitch floating /></ThemeProvider>);
