import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Company, Event, Invoice, InvoicePage, InvoiceSort, ManagedConnection, SortDirection } from '../../app/contracts.js';
import { mockInvoiceInput } from '../../app/mock/invoice-input.js';
import { ThemeProvider, ThemeSwitch } from './theme.js';
import { InvoiceDetails } from './invoice-details.js';
import { formatAddedDate, formatAppDateTime, formatInvoiceDate } from './invoice-date.js';
import type { ConnectionStatus } from '../../app/contracts.js';
import { connectionFailureMessage } from '../../app/connection-errors.js';
import { ResizableHeader, ResizableTable } from './resizable-table.js';
import './style.css';

type Status = { company: Company | null; companies: Company[]; mode: 'mock' | 'live'; emailEnabled: boolean; emailTo: string;
    diagnosticRef: string | null; connection: ConnectionStatus; connections?: ManagedConnection[] };
type AdminSession = { username: string; mustChangePassword: boolean };
type View = { tab: string; companyId: string; addConnectionId: string };
const connectionColumns = [
    { id: 'connection', label: 'Connection', defaultWidth: 220, minWidth: 120 },
    { id: 'status', label: 'Status', defaultWidth: 140 },
    { id: 'entities', label: 'Linked entities', defaultWidth: 240, minWidth: 120, maxAutoWidth: 320 },
    { id: 'actions', label: 'Actions', defaultWidth: 360, minWidth: 160, maxAutoWidth: 480 },
];
const activityColumns = [
    { id: 'task', label: 'Task', defaultWidth: 220, minWidth: 120 },
    { id: 'status', label: 'Status', defaultWidth: 140 },
    { id: 'attempts', label: 'Failed attempts', defaultWidth: 160 },
    { id: 'details', label: 'Details', defaultWidth: 300, minWidth: 120, maxAutoWidth: 400 },
];
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
function connectionLabel(connection: ConnectionStatus) {
    return connection.state === 'connected' ? 'Connected' : connection.state === 'reconnect_required' ? 'Reconnect required'
        : connection.state === 'needs_entity' ? 'Add an entity first' : connection.state === 'unconfigured' ? 'Server setup required'
            : connection.state === 'mock' ? 'Simulated' : 'Disconnected';
}
const syncQueuedNotice = 'Synchronization queued. The worker will pick it up shortly.';
const connectionSyncNotice = 'ANAF connected. Initial synchronization will start shortly.';
function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return <div className="toast" role="status">
        <span>{message}</span>
        <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
    </div>;
}
function StandaloneThemeHeader() {
    return <header className="standalone-topbar"><ThemeSwitch /></header>;
}
type ScrollbarGeometry = { visible: boolean; left: number; width: number; contentWidth: number; maximum: number; value: number };
function ViewportHorizontalScrollbar({ targetRef }: { targetRef: React.RefObject<HTMLDivElement | null> }) {
    const scrollbar = useRef<HTMLDivElement>(null);
    const [geometry, setGeometry] = useState<ScrollbarGeometry>({
        visible: false, left: 0, width: 0, contentWidth: 0, maximum: 0, value: 0,
    });
    useEffect(() => {
        const target = targetRef.current;
        if (!target) return;
        function measure() {
            const bounds = target!.getBoundingClientRect();
            const left = Math.max(0, bounds.left);
            const right = Math.min(window.innerWidth, bounds.right);
            const maximum = Math.max(0, target!.scrollWidth - target!.clientWidth);
            setGeometry({
                visible: maximum > 1 && bounds.top < window.innerHeight - 16
                    && bounds.bottom > window.innerHeight,
                left,
                width: Math.max(0, right - left),
                contentWidth: target!.scrollWidth,
                maximum,
                value: target!.scrollLeft,
            });
            if (scrollbar.current && scrollbar.current.scrollLeft !== target!.scrollLeft) {
                scrollbar.current.scrollLeft = target!.scrollLeft;
            }
        }
        const observer = new ResizeObserver(measure);
        observer.observe(target);
        if (target.firstElementChild) observer.observe(target.firstElementChild);
        target.addEventListener('scroll', measure, { passive: true });
        window.addEventListener('scroll', measure, { passive: true });
        window.addEventListener('resize', measure, { passive: true });
        measure();
        return () => {
            observer.disconnect();
            target.removeEventListener('scroll', measure);
            window.removeEventListener('scroll', measure);
            window.removeEventListener('resize', measure);
        };
    }, [targetRef]);
    return <div ref={scrollbar} className="invoice-viewport-scrollbar" role="scrollbar" aria-label="Invoice table horizontal scroll"
        aria-controls="invoice-table-scroll" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={Math.round(geometry.maximum)}
        aria-valuenow={Math.round(geometry.value)} tabIndex={geometry.visible ? 0 : -1}
        style={{ display: geometry.visible ? 'block' : 'none', left: geometry.left, width: geometry.width }}
        onWheel={event => {
            const movement = event.deltaX || (event.shiftKey ? event.deltaY : 0);
            if (!movement) return;
            event.preventDefault();
            event.currentTarget.scrollLeft += movement;
            if (targetRef.current) targetRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onKeyDown={event => {
            const movements: Partial<Record<React.KeyboardEvent['key'], number>> = {
                ArrowLeft: -40, ArrowRight: 40, PageUp: -event.currentTarget.clientWidth * .8,
                PageDown: event.currentTarget.clientWidth * .8, Home: -geometry.maximum, End: geometry.maximum,
            };
            const movement = movements[event.key];
            if (movement === undefined) return;
            event.preventDefault();
            event.currentTarget.scrollLeft += movement;
            if (targetRef.current) targetRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onScroll={event => {
            const target = targetRef.current;
            const value = event.currentTarget.scrollLeft;
            if (!target || target.scrollLeft === value) return;
            target.scrollLeft = value;
            setGeometry(current => ({ ...current, value }));
        }}><div style={{ width: geometry.contentWidth }} /></div>;
}
type EntityDraft = { name: string; kind: 'company' | 'individual'; cif: string; emailTo: string;
    emailEnabled: boolean; pollSeconds: number; connectionId: string };
function EntityForm({ initial, connections, creating, busy, onSave }: { initial: EntityDraft; connections: ManagedConnection[];
    creating: boolean; busy: boolean;
    onSave: (value: EntityDraft) => Promise<void> }) {
    const [draft, setDraft] = useState(initial);
    useEffect(() => setDraft(initial), [initial.name, initial.kind, initial.cif, initial.emailTo,
        initial.emailEnabled, initial.pollSeconds, initial.connectionId]);
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
        <label>ANAF connection<select value={draft.connectionId}
            onChange={event => setDraft({ ...draft, connectionId: event.target.value })} disabled={busy}>
            {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
        </select></label>
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
    const [username, setUsername] = useState('admin');
    const [password, setPassword] = useState('');
    const [forgotOpen, setForgotOpen] = useState(false);
    const [recoveryEmail, setRecoveryEmail] = useState('');
    const [recoveryNotice, setRecoveryNotice] = useState('');
    const [recoveryError, setRecoveryError] = useState('');
    const [recoveryBusy, setRecoveryBusy] = useState(false);
    const [resetToken, setResetToken] = useState(() => new URLSearchParams(location.search).get('reset') ?? '');
    const [resetPassword, setResetPassword] = useState('');
    const [confirmResetPassword, setConfirmResetPassword] = useState('');
    const [mustChangePassword, setMustChangePassword] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [loadingCompanyId, setLoadingCompanyId] = useState<string | null>(null);
    const [companyId, setCompanyId] = useState(() => new URLSearchParams(location.search).get('companyId')
        ?? localStorage.getItem('efactura-company') ?? '');
    const activeCompanyId = useRef(companyId);
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
    const [selectedInvoices, setSelectedInvoices] = useState<Map<string, boolean>>(() => new Map());
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectionBusy, setSelectionBusy] = useState(false);
    const [bulkDownloading, setBulkDownloading] = useState<'zip' | 'pdf' | null>(null);
    const invoiceTableScroll = useRef<HTMLDivElement>(null);
    const [tab, setTab] = useState(new URLSearchParams(location.search).get('view') === 'connections' ? 'connections' : 'inbox');
    const [connectionName, setConnectionName] = useState('');
    const [creatingConnection, setCreatingConnection] = useState(false);
    const [confirmConnectionId, setConfirmConnectionId] = useState<string | null>(null);
    const [newEntityConnectionId, setNewEntityConnectionId] = useState('');
    const [viewHistory, setViewHistory] = useState<View[]>([]);
    const [search, setSearch] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const activeSearchTerm = useRef(searchTerm);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState(() => {
        const result = new URLSearchParams(location.search).get('anaf');
        return result === 'connected' ? connectionSyncNotice
            : result === 'failed' ? connectionFailureMessage(new URLSearchParams(location.search).get('reason')) : '';
    });
    const connectedConnectionId = useRef(new URLSearchParams(location.search).get('connection'));
    const [queuedSync, setQueuedSync] = useState<{ companyId: string; lastSync: string | null; nextSync: string } | null>(null);
    const [skipSetup, setSkipSetup] = useState(false);
    const [busy, setBusy] = useState(false);
    const [scenario, setScenario] = useState('normal');
    const [showInvoiceForm, setShowInvoiceForm] = useState(false);
    const [mockNotice, setMockNotice] = useState('');
    const [mockError, setMockError] = useState('');
    async function load() {
        const requestedId = activeCompanyId.current;
        try {
            const admin = await api<AdminSession>('session');
            setUsername(admin.username);
            setAuthenticated(true);
            setMustChangePassword(admin.mustChangePassword);
            if (admin.mustChangePassword) return;
            const next = await api<Status>('status', undefined, requestedId || undefined);
            if (requestedId !== activeCompanyId.current || (requestedId && next.company?.id !== requestedId)) return;
            if (!next.company) {
                setStatus(next); setInvoices([]); setInvoiceTotal(0); setMatchingTotal(0);
                setEvents([]); setTab(current => current === 'inbox'
                    ? next.connections?.length ? 'add' : 'connections' : current);
                setLoadingCompanyId(null); return;
            }
            const query = new URLSearchParams({ sortBy: invoiceSort.by, direction: invoiceSort.direction,
                page: String(page), search: searchTerm });
            const [result, jobs] = await Promise.all([api<InvoicePage>(`invoices?${query}`, undefined, next.company.id),
                api<Event[]>('events', undefined, next.company.id)]);
            if (requestedId !== activeCompanyId.current
                || activeInvoiceSort.current.by !== invoiceSort.by || activeInvoiceSort.current.direction !== invoiceSort.direction
                || activePage.current !== page || activeSearchTerm.current !== searchTerm) return;
            setStatus(next); setInvoices(result.items); setInvoiceTotal(result.allTotal); setMatchingTotal(result.total);
            setSelectedInvoices(current => {
                const updated = new Map(current);
                for (const invoice of result.items) if (updated.has(invoice.id)) updated.set(invoice.id, invoice.pdfReady);
                return updated;
            });
            setEvents(jobs); setAuthenticated(true); setLoadingCompanyId(null);
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
            if (requestedId !== activeCompanyId.current) return;
            setLoadingCompanyId(null);
            if (e instanceof Error && e.message === 'SIGN_IN') setAuthenticated(false);
            else if (e instanceof Error && e.message === 'Entity not found.' && activeCompanyId.current) {
                activeCompanyId.current = ''; setCompanyId(''); localStorage.removeItem('efactura-company');
            }
            else setError(e instanceof Error ? e.message : 'Cannot reach the application.');
        }
    }
    useEffect(() => {
        const url = new URL(location.href);
        if (url.searchParams.has('anaf') || url.searchParams.has('view') || url.searchParams.has('reset')) {
            url.searchParams.delete('anaf'); url.searchParams.delete('reason'); url.searchParams.delete('view');
            url.searchParams.delete('connection'); url.searchParams.delete('reset');
            history.replaceState(null, '', url);
        }
    }, []);
    useEffect(() => {
        if (search === activeSearchTerm.current) return;
        const timer = setTimeout(() => {
            activeSearchTerm.current = search;
            activePage.current = 1;
            setPage(1); setSearchTerm(search); setSelectedId(null); setSelectedInvoices(new Map()); setSelectionMode(false);
        }, 250);
        return () => clearTimeout(timer);
    }, [search]);
    useEffect(() => { void load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, [companyId, invoiceSort, page, searchTerm]);
    useEffect(() => {
        if (!queuedSync) return;
        if (status?.company?.id === queuedSync.companyId &&
            (status.company.lastSync !== queuedSync.lastSync || status.company.nextSync !== queuedSync.nextSync)) {
            setQueuedSync(null);
            setNotice(current => current === syncQueuedNotice ? '' : current);
        }
    }, [queuedSync, status]);
    useEffect(() => {
        if (!queuedSync) return;
        const timer = setTimeout(() => {
            setQueuedSync(null);
            setNotice(current => current === syncQueuedNotice ? '' : current);
        }, 15000);
        return () => clearTimeout(timer);
    }, [queuedSync]);
    useEffect(() => {
        if (notice !== connectionSyncNotice || !connectedConnectionId.current || !status) return;
        const managed = status.connections?.find(connection => connection.id === connectedConnectionId.current);
        if (!managed?.entityIds.length) return;
        if (managed.entityIds.every(id => {
            const entity = status.companies.find(company => company.id === id);
            return entity?.initialized && entity.lastSync !== null;
        })) setNotice('');
    }, [notice, status]);
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
    function selectInvoice(invoice: Invoice, checked: boolean) {
        setSelectedInvoices(current => {
            const updated = new Map(current);
            if (checked) updated.set(invoice.id, invoice.pdfReady);
            else updated.delete(invoice.id);
            return updated;
        });
    }
    async function selectAllInvoices(checked: boolean) {
        if (!checked) { setSelectedInvoices(new Map()); setSelectionMode(false); return; }
        const requestedCompanyId = currentCompanyId;
        const requestedSearch = activeSearchTerm.current;
        setSelectionMode(true);
        setSelectionBusy(true); setError('');
        try {
            const query = new URLSearchParams({ search: requestedSearch });
            const result = await api<{ items: { id: string; pdfReady: boolean }[] }>(`invoices/selection?${query}`,
                undefined, requestedCompanyId);
            if (requestedCompanyId !== activeCompanyId.current || requestedSearch !== activeSearchTerm.current) return;
            setSelectedInvoices(new Map(result.items.map(invoice => [invoice.id, invoice.pdfReady])));
        } catch (e) {
            if (e instanceof Error && e.message === 'SIGN_IN') setAuthenticated(false);
            else setError(e instanceof Error ? e.message : 'Could not select the invoices.');
        } finally { setSelectionBusy(false); }
    }
    async function downloadSelected(kind: 'zip' | 'pdf') {
        if (!currentCompanyId || !selectedInvoices.size) return;
        setBulkDownloading(kind); setError('');
        try {
            const url = new URL(`/api/invoices/bulk/${kind}`, location.origin);
            url.searchParams.set('companyId', currentCompanyId);
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invoiceIds: [...selectedInvoices.keys()] }) });
            if (response.status === 401) throw new Error('SIGN_IN');
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.message ?? 'Could not prepare the selected invoices.');
            }
            const href = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = href;
            link.download = `invoice-${kind === 'zip' ? 'zips' : 'pdfs'}.zip`;
            document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(href), 0);
        } catch (e) {
            if (e instanceof Error && e.message === 'SIGN_IN') setAuthenticated(false);
            else setError(e instanceof Error ? e.message : 'Could not prepare the selected invoices.');
        } finally { setBulkDownloading(null); }
    }
    async function action(work: () => Promise<unknown>, message: string) {
        setBusy(true); setError(''); setNotice('');
        try { await work(); setNotice(message); await load(); }
        catch (e) { setError(e instanceof Error ? e.message === 'SIGN_IN' ? 'Incorrect username or password, or session expired.' : e.message : 'Request failed.'); }
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
    if (authenticated === null && !error) return <><StandaloneThemeHeader />
        <div className="loading">Opening your invoice workspace…</div></>;
    if (resetToken) return <main className="login-shell">
        <StandaloneThemeHeader />
        <div className="brand"><span className="brand-icon">eF</span> eFactura <span>Manager</span></div>
        <form className="login-card" onSubmit={event => { event.preventDefault();
            if (resetPassword !== confirmResetPassword) {
                setRecoveryError('The new passwords do not match.'); return;
            }
            setRecoveryBusy(true); setRecoveryError('');
            void api<{ ok: boolean }>('password-reset/complete', { token: resetToken, newPassword: resetPassword })
                .then(() => {
                    setResetToken(''); setResetPassword(''); setConfirmResetPassword('');
                    setAuthenticated(false); setForgotOpen(false);
                    setRecoveryNotice('Password changed. Sign in with your new password.');
                })
                .catch(error => setRecoveryError(error instanceof Error ? error.message : 'Could not reset the password.'))
                .finally(() => setRecoveryBusy(false));
        }}>
            <span className="eyebrow">ACCOUNT RECOVERY</span><h1>Choose a new password</h1>
            <p>This link can be used once and expires after 30 minutes.</p>
            <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128}
                value={resetPassword} onChange={event => setResetPassword(event.target.value)} /></label>
            <label>Confirm new password<input type="password" autoComplete="new-password" required
                value={confirmResetPassword} onChange={event => setConfirmResetPassword(event.target.value)} /></label>
            {recoveryError && <p className="alert error" role="alert">{recoveryError}</p>}
            <button className="primary" disabled={recoveryBusy}>Change password</button>
        </form>
    </main>;
    if (!authenticated && forgotOpen) return <main className="login-shell">
        <StandaloneThemeHeader />
        {recoveryNotice && <div className="toast-stack"><Toast message={recoveryNotice}
            onDismiss={() => setRecoveryNotice('')} /></div>}
        <div className="brand"><span className="brand-icon">eF</span> eFactura <span>Manager</span></div>
        <form className="login-card" onSubmit={event => { event.preventDefault();
            setRecoveryBusy(true); setRecoveryError('');
            void api<{ message: string }>('password-reset/request', { email: recoveryEmail })
                .then(result => setRecoveryNotice(result.message))
                .catch(() => setRecoveryNotice('If this email address is registered, a password reset link will be sent.'))
                .finally(() => setRecoveryBusy(false));
        }}>
            <span className="eyebrow">ACCOUNT RECOVERY</span><h1>Forgot password?</h1>
            <p>Enter an email address configured for one of your managed entities. If it matches, we’ll send a reset link there.</p>
            <label>Email address<input type="email" autoComplete="email" required maxLength={254}
                value={recoveryEmail} onChange={event => setRecoveryEmail(event.target.value)} /></label>
            <button className="primary recovery-submit" disabled={recoveryBusy}>Send reset link</button>
            <button type="button" className="login-link" onClick={() => { setForgotOpen(false); setRecoveryNotice('');
                setRecoveryError(''); }}>Back to sign in</button>
        </form>
    </main>;
    if (!authenticated) return <main className="login-shell">
        <StandaloneThemeHeader />
        {recoveryNotice && <div className="toast-stack"><Toast message={recoveryNotice}
            onDismiss={() => setRecoveryNotice('')} /></div>}
        <div className="brand"><span className="brand-icon">eF</span> eFactura <span>Manager</span></div>
        <form className="login-card" onSubmit={e => { e.preventDefault(); void action(async () => {
            const admin = await api<AdminSession>('login', { username, password, rememberMe });
            setPassword(''); setAuthenticated(true); setMustChangePassword(admin.mustChangePassword);
        }, ''); }}>
            <span className="eyebrow">YOUR INVOICE WORKSPACE</span><h1>Welcome back.</h1>
            <p>Keep track of invoices, downloads and notifications in one place.</p>
            <label>Username<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
            <label className="remember-me"><input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} aria-describedby="remember-me-help" />Remember me</label>
            <p id="remember-me-help" className="muted">Stay signed in for 30 days on this browser.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>Sign in →</button>
            <button type="button" className="login-link" onClick={() => { setForgotOpen(true); setRecoveryNotice('');
                setError(''); }}>Forgot password?</button>
        </form><p className="login-foot">Self-hosted. Your invoices stay in your workspace.</p>
    </main>;
    if (mustChangePassword) return <main className="login-shell">
        <StandaloneThemeHeader />
        <div className="brand"><span className="brand-icon">eF</span> eFactura <span>Manager</span></div>
        <form className="login-card" onSubmit={event => { event.preventDefault();
            if (newPassword !== confirmPassword) { setError('The new passwords do not match.'); return; }
            void action(async () => {
                await api<AdminSession>('password', { currentPassword, newPassword, rememberMe });
                setTab('connections');
                setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setMustChangePassword(false);
            }, 'Administrator password changed.');
        }}>
            <span className="eyebrow">FIRST SIGN-IN</span><h1>Change your temporary password</h1>
            <p>Choose a new password before managing invoices or entities.</p>
            <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword}
                onChange={event => setCurrentPassword(event.target.value)} /></label>
            <label>New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128}
                value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
            <label>Confirm new password<input type="password" autoComplete="new-password" required value={confirmPassword}
                onChange={event => setConfirmPassword(event.target.value)} /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>Change password</button>
        </form>
    </main>;
    if (!status) return <><StandaloneThemeHeader />
        <div className="loading">{error || 'Opening your invoice workspace…'}</div></>;
    const workspace = status;
    const currentCompany = status.company;
    const currentCompanyId = currentCompany?.id ?? '';
    const connections = status.connections ?? [];
    const selectedNewEntityConnectionId = connections.some(connection => connection.id === newEntityConnectionId)
        ? newEntityConnectionId : connections[0]?.id ?? '';
    const selected = invoices.find(i => i.id === selectedId);
    function selectCompany(id: string, created?: Company) {
        if (id && id === activeCompanyId.current && status?.company?.id === id) {
            setTab('inbox');
            return;
        }
        activeCompanyId.current = id;
        setCompanyId(id);
        setTab(id ? 'inbox' : 'add');
        setLoadingCompanyId(id || null);
        if (id) localStorage.setItem('efactura-company', id);
        else localStorage.removeItem('efactura-company');
        activePage.current = 1;
        setPage(1); setSelectedId(null); setSelectedInvoices(new Map()); setSelectionMode(false);
        setInvoices([]); setInvoiceTotal(0); setMatchingTotal(0);
        setEvents([]); setNotice(''); setError('');
        setStatus(current => current ? {
            ...current,
            companies: created && !current.companies.some(company => company.id === created.id)
                ? [...current.companies, created] : current.companies,
            company: current.companies.find(company => company.id === id) ?? created ?? null,
        } : current);
        setQueuedSync(null);
    }
    function viewAvailable(view: View) {
        if (view.tab === 'connections' || view.tab === 'add') return true;
        if (view.tab === 'mock' && workspace.mode !== 'mock') return false;
        return workspace.companies.some(company => company.id === view.companyId);
    }
    const previousView = [...viewHistory].reverse().find(viewAvailable);
    function viewLabel(view: View) {
        if (view.tab === 'connections') return 'ANAF connections';
        if (view.tab === 'add') return 'Add managed entity';
        const name = workspace.companies.find(company => company.id === view.companyId)?.name ?? 'Entity';
        const section = view.tab === 'inbox' ? 'Invoices' : view.tab === 'activity' ? 'Activity'
            : view.tab === 'settings' ? 'Settings' : 'Mocked ANAF';
        return `${name} / ${section}`;
    }
    function showView(view: View) {
        setNewEntityConnectionId(view.addConnectionId);
        if (view.companyId !== activeCompanyId.current
            && workspace.companies.some(company => company.id === view.companyId)) selectCompany(view.companyId);
        setTab(view.tab);
        if (view.tab !== 'mock') setMockNotice('');
        if (view.tab !== 'inbox') setSelectedId(null);
    }
    function navigate(nextTab: string, companyId = activeCompanyId.current, addConnectionId = newEntityConnectionId) {
        const current = { tab, companyId: activeCompanyId.current, addConnectionId: newEntityConnectionId };
        if (current.tab === nextTab && current.companyId === companyId
            && (nextTab !== 'add' || current.addConnectionId === addConnectionId)) return;
        setViewHistory(history => [...history.slice(-29), current]);
        showView({ tab: nextTab, companyId, addConnectionId });
    }
    function goBack() {
        const index = viewHistory.findLastIndex(viewAvailable);
        if (index < 0) return;
        const previous = viewHistory[index]!;
        setViewHistory(viewHistory.slice(0, index));
        showView(previous);
    }
    async function removeCompany(target: Company) {
        const result = await api<{ nextCompanyId: string | null }>(`companies/${target.id}`, undefined, undefined, 'DELETE');
        setDeleteTarget(null);
        selectCompany(result.nextCompanyId ?? '');
        setStatus(current => current ? { ...current, companies: current.companies.filter(company => company.id !== target.id) } : current);
        setNotice(`${target.name} was deleted.`);
    }
    const pageCount = Math.max(1, Math.ceil(matchingTotal / 50));
    const allInvoicesSelected = matchingTotal > 0 && selectedInvoices.size === matchingTotal
        && invoices.every(invoice => selectedInvoices.has(invoice.id));
    const selectedPdfPending = [...selectedInvoices.values()].some(pdfReady => !pdfReady);
    const connection = status?.connection;
    const needsConnection = status?.mode === 'live' && connection && connection.state !== 'connected';
    const setup = needsConnection && currentCompany && !currentCompany.initialized && !skipSetup && tab === 'inbox';
    const failed = events.filter(e => e.status === 'failed').length;
    return <div className={`shell${tab === 'inbox' && selected ? ' has-details' : ''}`}>
        {(notice || (tab === 'mock' && mockNotice)) && <div className="toast-stack">
            {notice && <Toast message={notice} onDismiss={() => setNotice('')} />}
            {tab === 'mock' && mockNotice && <Toast message={mockNotice} onDismiss={() => setMockNotice('')} />}
        </div>}
        <aside className="sidebar">
            <div className="brand"><span className="brand-icon">eF</span><div>eFactura<small>MANAGER</small></div></div>
            {(['company', 'individual'] as const).map(kind => <div key={kind} className="managed-group">
                <div className="workspace-label">Managed {kind === 'company' ? 'companies' : 'individuals'}</div>
                {status.companies.filter(company => company.kind === kind).map(company =>
                    <button key={company.id} className={`nav entity-nav${tab !== 'add' && tab !== 'connections' && currentCompanyId === company.id ? ' active' : ''}`}
                        aria-pressed={tab !== 'add' && tab !== 'connections' && currentCompanyId === company.id}
                        onClick={() => navigate('inbox', company.id)}>
                        <span aria-hidden="true">{kind === 'company' ? '▦' : '♙'}</span>{company.name}</button>)}
                {!status.companies.some(company => company.kind === kind) && <span className="nav-empty">None yet</span>}
            </div>)}
            <div className="sidebar-add-section">
                <button className={`nav add-entity-nav${tab === 'connections' ? ' active' : ''}`}
                    onClick={() => navigate('connections')}>
                    <span aria-hidden="true">◎</span>Manage ANAF connections</button>
                <button className={`nav add-entity-nav${tab === 'add' ? ' active' : ''}`} onClick={() => {
                    navigate('add', activeCompanyId.current, currentCompany?.connectionId ?? selectedNewEntityConnectionId);
                }}>
                    <span aria-hidden="true">＋</span>Add managed entity</button>
            </div>
            <div className="sidebar-bottom"><span className="avatar">AD</span><div>{username}<small>Administrator</small></div></div>
            <button className="signout" onClick={() => void action(async () => { await api('logout', {}); setAuthenticated(false); }, '')}>Sign out</button>
        </aside>
        <main className="main">
            <header className="topbar"><span>Workspace <span className="slash">/</span> {tab === 'connections' ? 'Manage ANAF connections'
                : tab === 'add' || !currentCompany ? 'Add managed entity'
                : `${currentCompany.name} / ${tab === 'inbox' ? 'Invoices' : tab === 'activity' ? 'Activity' : tab === 'mock' ? 'Mocked ANAF' : 'Settings'}`}</span>
                <ThemeSwitch /></header>
            {tab !== 'add' && tab !== 'connections' && currentCompany && <nav className="entity-tabs" aria-label="Entity views">
                {([['inbox', 'Invoices'], ['activity', 'Activity'], ['settings', 'Settings'],
                    ...(status.mode === 'mock' ? [['mock', 'Mocked ANAF']] : [])]).map(([id, label]) =>
                    <button key={id} className="entity-tab" aria-current={tab === id ? 'page' : undefined}
                        onClick={() => navigate(id)}>
                        {label}{id === 'inbox' && <span className="entity-tab-count">{invoiceTotal}</span>}
                    </button>)}
            </nav>}
            <div className="content">
                {previousView && <button className="context-back" onClick={goBack}>← Back to {viewLabel(previousView)}</button>}
                {tab === 'connections' ? <>
                    <section className="heading"><div><span className="eyebrow">WORKSPACE AUTHORIZATION</span>
                        <h1>Manage ANAF connections</h1>
                        <p>One certificate authorization can serve several entities. Assign each entity to the connection that can access its invoices.</p>
                    </div></section>
                    {error && <div className="alert error" role="alert">{error}</div>}
                    {!connections.length && <div className="alert onboarding-banner" role="status">
                        <strong>Start by adding an ANAF connection.</strong>
                        <p>Create a connection, then add a managed company or individual and assign it to that connection. Once an entity is linked, authorize the connection with your qualified certificate.</p>
                    </div>}
                    <section className="card connection-list">
                        <div className="card-toolbar"><h2>Connections <span className="count">{connections.length}</span></h2>
                            <button className="primary" onClick={() => setCreatingConnection(true)}>＋ Add ANAF connection</button></div>
                        {creatingConnection && <form className="connection-create" onSubmit={event => { event.preventDefault();
                            void action(async () => {
                                const created = await api<{ id: string }>('connections', { name: connectionName });
                                setNewEntityConnectionId(created.id); setConnectionName(''); setCreatingConnection(false);
                            }, 'ANAF connection created. Add an entity to authorize it.');
                        }}>
                            <label>Connection name<input required maxLength={100} autoFocus value={connectionName}
                                onChange={event => setConnectionName(event.target.value)} placeholder="e.g. New ANAF certificate" /></label>
                            <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setCreatingConnection(false)}>Cancel</button>
                                <button className="primary" disabled={busy}>Create connection</button></div>
                        </form>}
                        {!!connections.length && <div className="table-scroll"><ResizableTable tableId="connections" columns={connectionColumns}
                            className="connection-table"><thead><tr>
                            <ResizableHeader columnId="connection">Connection</ResizableHeader>
                            <ResizableHeader columnId="status">Status</ResizableHeader>
                            <ResizableHeader columnId="entities">Linked entities</ResizableHeader>
                            <ResizableHeader columnId="actions">Actions</ResizableHeader>
                        </tr></thead><tbody>{connections.map(managed => <tr key={managed.id}>
                            <td><strong>{managed.name}</strong>{managed.status.connectedAt &&
                                <small>Connected on {date(managed.status.connectedAt)}</small>}</td>
                            <td><span className={`badge ${managed.status.state === 'connected' ? 'sent' : ''}`}>{connectionLabel(managed.status)}</span></td>
                            <td><div className="connection-entities">{managed.entityIds.map(id => {
                                const entity = status.companies.find(company => company.id === id);
                                return entity && <button key={id} className="quiet"
                                    onClick={() => navigate('inbox', id)}>{entity.name}</button>;
                            })}{!managed.entityIds.length && <span className="muted">No entities linked</span>}</div></td>
                            <td><div className="connection-actions">
                                {managed.status.canConnect && managed.status.state !== 'connected' &&
                                    <form method="post" action={`/api/anaf/connections/${managed.id}/connect`}>
                                        <button className="secondary" disabled={busy}>{managed.status.state === 'reconnect_required'
                                            ? 'Reconnect' : 'Connect'}</button></form>}
                                {managed.status.state === 'connected' && (confirmConnectionId === managed.id
                                    ? <><span className="muted">Pause collection for linked entities?</span>
                                        <button className="secondary" onClick={() => setConfirmConnectionId(null)}>Cancel</button>
                                        <button className="danger" disabled={busy} onClick={() => void action(async () => {
                                            await api(`anaf/connections/${managed.id}/disconnect`, {});
                                            setConfirmConnectionId(null);
                                        }, 'ANAF connection disconnected. Stored invoices remain available.')}>Confirm disconnect</button></>
                                    : <button className="secondary" onClick={() => setConfirmConnectionId(managed.id)}>Disconnect</button>)}
                                <button className="secondary" onClick={() => {
                                    navigate('add', activeCompanyId.current, managed.id);
                                }}>Add entity</button>
                            </div></td>
                        </tr>)}</tbody></ResizableTable></div>}
                    </section>
                </> : tab === 'add' || !currentCompany ? <>
                    <section className="heading"><div><span className="eyebrow">MANAGED ENTITIES</span>
                        <h1>Add managed entity</h1><p>Add a company or individual whose invoices this workspace should collect.</p></div></section>
                    {error && <div className="alert error" role="alert">{error}</div>}
                    {!connections.length ? <div className="alert onboarding-banner" role="status">
                        <strong>Add an ANAF connection before adding an entity.</strong>
                        <p>Each company or individual needs a connection that can access its invoices.</p>
                        <button className="secondary" onClick={() => navigate('connections')}>Manage ANAF connections</button>
                    </div> : <section className="card settings-card add-entity-card">
                        <EntityForm key={selectedNewEntityConnectionId} connections={connections}
                            initial={{ name: '', kind: 'company', cif: '', emailTo: status.emailTo,
                                emailEnabled: true, pollSeconds: 60, connectionId: selectedNewEntityConnectionId }} creating busy={busy} onSave={value => action(async () => {
                            const created = await api<Company>('companies', value);
                            if (previousView?.tab === 'connections') goBack();
                            else selectCompany(created.id, created);
                        }, previousView?.tab === 'connections'
                            ? 'Entity added. Connect its ANAF connection to begin collection.' : 'Entity added.')} />
                    </section>}
                </> : loadingCompanyId === currentCompanyId ? <section className="entity-loading" role="status">
                    <span className="eyebrow">WORKSPACE</span><h1>{currentCompany.name}</h1>
                    <p>Loading invoices and activity…</p>
                </section> : <>
                <section className="heading"><div><span className="eyebrow">{tab === 'inbox' ? 'RECEIVED INVOICES' : 'WORKSPACE'}</span>
                    <h1>{tab === 'inbox' ? 'Your invoice inbox' : tab === 'activity' ? 'Background activity' : tab === 'mock' ? 'Mocked ANAF' : 'Workspace settings'}</h1>
                    <p>{tab === 'inbox' ? 'Automatically collected. Ready when you need them.' : tab === 'activity' ? 'Follow PDF generation and email delivery, including retries.' : tab === 'mock' ? 'Create test invoices, simulate service conditions and check notifications.' : 'Control synchronization and email delivery.'}</p></div>
                    <button className="primary" disabled={busy || !!needsConnection} onClick={() => void action(async () => {
                        await api('sync', {}, currentCompanyId);
                        setQueuedSync({ companyId: currentCompanyId, lastSync: currentCompany.lastSync, nextSync: currentCompany.nextSync });
                    }, syncQueuedNotice)}>↻ Sync now</button>
                </section>
                {error && <div className="alert error" role="alert">{error}</div>}
                {currentCompany.syncError && (status.mode !== 'mock' || tab === 'mock') && <div className="alert error">Last sync: {currentCompany.syncError}</div>}
                {needsConnection && !setup && <div className="alert connection-alert" role="status">
                    <p>{connection.state === 'reconnect_required' ? 'ANAF authorization needs renewing.' : 'ANAF is not connected.'} Automatic collection is paused for this entity. Stored invoices remain available.</p>
                    <button className="secondary" onClick={() => navigate('connections')}>Manage ANAF connections</button>
                </div>}
                {setup && <div className="card settings-card"><h2>Connect this entity to ANAF</h2>
                    <p>Manage its assigned connection to begin collecting invoices. The initial import will not send an email for each existing invoice.</p>
                    <button className="primary" onClick={() => navigate('connections')}>Manage ANAF connections</button>
                    <button className="secondary" onClick={() => setSkipSetup(true)}>View stored invoices</button>
                </div>}
                {!setup && <section className="stats">
                    <div><span>Invoices collected</span><strong>{invoiceTotal}</strong></div>
                    <div><span>Last successful sync</span><strong className="small-value">{date(currentCompany.lastSync)}</strong><small>Checks every {currentCompany.pollSeconds} seconds</small></div>
                    <div><span>Email notifications</span><strong className="small-value">{status?.emailEnabled ? 'Enabled' : 'Disabled'}</strong><small>{failed ? `${failed} task(s) need attention` : ''}</small></div>
                </section>}
                {tab === 'inbox' && !setup && <section className="card">
                    <div className="card-toolbar"><h2>All received invoices <span className="count">{matchingTotal}</span></h2>
                        <input className="search" placeholder="Search supplier or invoice…" aria-label="Search invoices" value={search}
                            onChange={e => { setSearch(e.target.value); setSelectedInvoices(new Map()); setSelectionMode(false); }} /></div>
                    <div id="invoice-table-scroll" ref={invoiceTableScroll} className="table-scroll invoice-table-scroll"
                        role="region" aria-label="Invoice table" tabIndex={0}><ResizableTable tableId="invoices" columns={[
                            ...(selectionMode ? [{ id: 'select', label: 'Select', defaultWidth: 48, minWidth: 44 }] : []),
                            { id: 'supplier', label: 'Supplier / invoice', defaultWidth: 240, minWidth: 160,
                                autoFitLines: 2, autoFitSelector: '.invoice-supplier', fillRemaining: true },
                            { id: 'issue', label: 'Issue date', defaultWidth: 140 },
                            { id: 'added', label: 'Added date', defaultWidth: 170 },
                            { id: 'amount', label: 'Invoice amount', defaultWidth: 150 },
                            { id: 'documents', label: 'Documents', defaultWidth: 160, minWidth: 120 },
                        ]}><thead><tr className="bulk-actions-row"><th colSpan={selectionMode ? 6 : 5}>
                        <div className="bulk-actions"><label className="bulk-select-all"><input type="checkbox" checked={allInvoicesSelected || selectionBusy}
                            ref={element => { if (element) element.indeterminate = selectedInvoices.size > 0 && !allInvoicesSelected && !selectionBusy; }}
                            disabled={!invoices.length || bulkDownloading !== null || selectionBusy}
                            onChange={event => void selectAllInvoices(event.target.checked)} />
                            Select all</label><span className="bulk-count">{selectedInvoices.size} selected</span>
                            <div className="bulk-downloads"><button className="secondary" disabled={!selectedInvoices.size || bulkDownloading !== null || selectionBusy}
                                onClick={() => void downloadSelected('zip')}>{bulkDownloading === 'zip' ? 'Preparing ZIPs…' : 'Download selected ZIPs'}</button>
                                <button className="secondary" disabled={!selectedInvoices.size || selectedPdfPending || bulkDownloading !== null || selectionBusy}
                                    title={selectedPdfPending ? 'A selected PDF is still being prepared.' : undefined}
                                    onClick={() => void downloadSelected('pdf')}>{bulkDownloading === 'pdf' ? 'Preparing PDFs…' : 'Download selected PDFs'}</button></div>
                        </div></th></tr><tr className="invoice-column-headings">{selectionMode && <ResizableHeader columnId="select"
                            className="invoice-select-heading"><span className="visually-hidden">Select</span></ResizableHeader>}
                        <ResizableHeader columnId="supplier">Supplier / invoice</ResizableHeader>
                        <ResizableHeader columnId="issue" aria-sort={invoiceSort.by === 'issue' ? invoiceSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="sort-heading" onClick={() => sortInvoices('issue')}>Issue date <span aria-hidden="true">{invoiceSort.by === 'issue' ? invoiceSort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></ResizableHeader>
                        <ResizableHeader columnId="added" aria-sort={invoiceSort.by === 'added' ? invoiceSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="sort-heading" onClick={() => sortInvoices('added')}>Added date <span aria-hidden="true">{invoiceSort.by === 'added' ? invoiceSort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></ResizableHeader>
                        <ResizableHeader columnId="amount">Invoice amount</ResizableHeader>
                        <ResizableHeader columnId="documents">Documents</ResizableHeader></tr></thead>
                        <tbody>{invoices.map(i => <tr key={i.id} className={`invoice-row${selectedId === i.id ? ' selected' : ''}`} onClick={event => {
                            if ((event.target as Element).closest('a, button, input')) return;
                            event.currentTarget.querySelector<HTMLButtonElement>('.invoice-link')?.focus({ preventScroll: true });
                            setSelectedId(i.id);
                        }}>
                            {selectionMode && <td className="invoice-select"><input type="checkbox" checked={selectedInvoices.has(i.id)} disabled={selectionBusy || bulkDownloading !== null}
                                aria-label={`Select invoice ${i.number} from ${i.supplier}`} onChange={event => selectInvoice(i, event.target.checked)} /></td>}
                            <td><button className="invoice-link" title={i.supplier} aria-expanded={selectedId === i.id}
                                aria-controls={selectedId === i.id ? 'invoice-details' : undefined} onClick={() => setSelectedId(i.id)}>
                                <span className="invoice-supplier">{i.supplier}</span><small>{i.number}</small></button></td>
                            <td>{formatInvoiceDate(i.issueDate)}</td><td>{i.addedDate ? formatAddedDate(i.addedDate) : '—'}</td>
                            <td className="amount">{i.total} <span>{i.currency}</span></td>
                            <td><a className="document" href={`/api/invoices/${i.id}/zip?companyId=${currentCompanyId}`}>ZIP ↓</a>{i.pdfReady ? <a className="document" href={`/api/invoices/${i.id}/pdf?companyId=${currentCompanyId}`}>PDF ↓</a> : <span className="muted">Preparing PDF</span>}</td>
                        </tr>)}</tbody></ResizableTable></div>
                    {!invoices.length && <div className="empty"><h2>{invoiceTotal ? 'No matching invoices' : 'Your inbox is ready'}</h2><p>{invoiceTotal ? 'Try a different supplier or invoice number.' : 'Run a synchronization to collect invoices from ANAF.'}</p></div>}
                    {matchingTotal > 0 && <nav className="pagination" aria-label="Invoice pages">
                        <span>Showing {(page - 1) * 50 + 1}–{Math.min(page * 50, matchingTotal)} of {matchingTotal}</span>
                        <div><button className="secondary" disabled={page === 1} onClick={() => changePage(page - 1)}>Previous</button>
                            <span>Page {page} of {pageCount}</span>
                            <button className="secondary" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>Next</button></div>
                    </nav>}
                </section>}
                {tab === 'activity' && <section className="card"><div className="card-toolbar"><h2>Recent tasks</h2><span className="muted">Automatic retries with backoff</span></div>
                    <div className="table-scroll"><ResizableTable tableId="activity" columns={activityColumns}><thead><tr>
                        <ResizableHeader columnId="task">Task</ResizableHeader><ResizableHeader columnId="status">Status</ResizableHeader>
                        <ResizableHeader columnId="attempts">Failed attempts</ResizableHeader><ResizableHeader columnId="details">Details</ResizableHeader>
                    </tr></thead><tbody>{events.map(e => <tr key={e.id}><td>{e.kind === 'invoice.pdf' ? 'Generate PDF' : 'Send invoice email'}<small>{date(e.createdAt)}</small></td>
                        <td><span className={`badge ${e.status}`}>{e.status === 'sent' ? 'Complete' : e.status}</span></td><td>{e.attempts}</td><td>{e.error ?? '—'}{['failed', 'skipped'].includes(e.status) && <button className="document" disabled={busy} onClick={() => void action(() => api(`events/${e.id}/retry`, {}, status?.company?.id), 'Task queued for another attempt.')}>Retry</button>}</td></tr>)}</tbody></ResizableTable></div>
                    {!events.length && <div className="empty">No background activity yet.</div>}
                </section>}
                {tab === 'settings' && <div className="settings-grid">
                    <section className="card settings-card"><h2>{currentCompany.name}</h2>
                        <p>Settings for this {currentCompany.kind}. Invoice data and job history stay separate for each entity.</p>
                        {status.diagnosticRef && <p className="muted">Diagnostic reference: <code>{status.diagnosticRef}</code></p>}
                        <EntityForm key={currentCompany.id} initial={{ name: currentCompany.name, kind: currentCompany.kind,
                            cif: currentCompany.cif, emailTo: currentCompany.emailTo, emailEnabled: currentCompany.emailEnabled,
                            pollSeconds: currentCompany.pollSeconds,
                            connectionId: currentCompany.connectionId }} connections={connections} busy={busy} creating={false}
                            onSave={value => action(() => api(`companies/${currentCompany.id}`, value), 'Entity settings saved.')} />
                        <hr /><button className="danger" disabled={busy} onClick={() => setDeleteTarget(currentCompany)}>Delete this {currentCompany.kind}</button>
                    </section>
                    <section className="card settings-card"><h2>Email transport</h2>
                        <p>Outgoing SMTP credentials remain in the server configuration. Each entity has its own notification address above.</p>
                    </section>
                </div>}
                {tab === 'mock' && status?.mode === 'mock' && <>
                    <div className="alert mock-banner"><span className="mode mock">Simulated ANAF data</span><p>This workspace uses test invoices. Email notifications use your configured delivery settings.</p></div>
                    {mockError && <div className="alert error" role="alert">{mockError}</div>}
                    <div className="settings-grid"><section className="card settings-card"><h2>Try a new invoice</h2><p>Finish the initial sync, then create a new invoice to exercise collection, PDF generation and email delivery.</p>
                    <button className="primary" disabled={busy || !currentCompany.initialized} onClick={() => setShowInvoiceForm(true)}>＋ Create simulated invoice</button>
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
                        <button className="secondary" onClick={() => navigate('activity')}>View delivery activity</button>
                    </section></div>
                </>}
                </>}
                <footer>eFactura Manager · © {new Date().getFullYear()} MD AI RESEARCH SRL <span>Original documents stored in your workspace · {currentCompany?.environment === 'prod' ? 'Production API environment' : 'ANAF test environment'}</span></footer>
            </div>
        </main>
        {tab === 'inbox' && !setup && !!invoices.length && <ViewportHorizontalScrollbar targetRef={invoiceTableScroll} />}
        {tab === 'inbox' && selected && currentCompany && <InvoiceDetails invoice={selected} companyId={currentCompany.id} onClose={() => setSelectedId(null)} />}
        {showInvoiceForm && status.mode === 'mock' && currentCompany && <SimulatedInvoiceForm companyId={currentCompany.id} onCancel={() => setShowInvoiceForm(false)} onCreated={number => {
            setShowInvoiceForm(false); setMockError('');
            setMockNotice(`Simulated invoice ${number} created. Wait for the next poll or choose Sync now.`);
            void load();
        }} />}
        {deleteTarget && <DeleteEntityDialog company={deleteTarget} onCancel={() => setDeleteTarget(null)}
            onDelete={() => removeCompany(deleteTarget)} />}
    </div>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><App /></ThemeProvider>);
