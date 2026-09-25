import type { AnafMode } from './config.js';

export type InvoiceData = {
    number: string; issueDate: string; dueDate: string; supplier: string;
    supplierCif: string; currency: string; net: string; tax: string; total: string;
    // Version marker for stored projections; total is the full invoice value, including VAT.
    totalBasis?: 'tax-inclusive';
    lines: { description: string; quantity: string; amount: string }[];
};
export type Invoice = InvoiceData & {
    id: string; messageId: string; createdAt: string; addedDate: string | null; pdfReady: boolean;
};
export type InvoiceSort = 'issue' | 'added';
export type SortDirection = 'asc' | 'desc';
export type InvoicePage = { items: Invoice[]; total: number; allTotal: number; page: number; pageSize: number };
export type Company = {
    id: string; workspaceId: string; cif: string; name: string; kind: 'company' | 'individual';
    emailTo: string; emailEnabled: boolean; mode: AnafMode; environment: 'prod' | 'test';
    pollSeconds: number; lastSync: string | null; nextSync: string;
    syncError: string | null; initialized: boolean;
};
export type Event = {
    id: string; companyId: string; kind: 'invoice.pdf' | 'invoice.email'; invoiceId: string;
    status: 'pending' | 'sent' | 'failed' | 'skipped'; attempts: number; error: string | null;
    createdAt: string;
};
export interface Repository {
    initialize(): Promise<void>;
    company(): Promise<Company>;
    updatePoll(seconds: number): Promise<void>;
    due(): Promise<boolean>;
    finishSync(error?: string): Promise<void>;
    hasInvoice(messageId: string): Promise<boolean>;
    addedDateBackfillPending(): Promise<boolean>;
    markAddedDateBackfilled(): Promise<void>;
    updateInvoiceAddedDate(messageId: string, addedDate: string | null): Promise<void>;
    insertInvoice(messageId: string, data: InvoiceData, notify: boolean, addedDate: string | null): Promise<void>;
    invoices(search?: string, sortBy?: InvoiceSort, direction?: SortDirection): Promise<Invoice[]>;
    invoicePage(search: string, sortBy: InvoiceSort, direction: SortDirection, page: number, pageSize: number): Promise<InvoicePage>;
    invoice(id: string): Promise<Invoice | null>;
    pdfReady(id: string): Promise<void>;
    events(): Promise<Event[]>;
    pendingEvents(): Promise<Event[]>;
    event(id: string): Promise<Event | null>;
    markPublished(id: string): Promise<void>;
    completeEvent(id: string, skipped?: boolean): Promise<void>;
    failEvent(id: string, error: string): Promise<void>;
    replayEvent(id: string): Promise<boolean>;
    close(): Promise<void>;
}
export interface SessionStore {
    saveSession(tokenHash: string, expiresAt: Date): Promise<void>;
    hasSession(tokenHash: string): Promise<boolean>;
    deleteSession(tokenHash: string): Promise<void>;
}
export type Job = { companyId: string; eventId?: string };
export interface JobQueue {
    start(): Promise<void>;
    publish(kind: 'sync' | 'event', job: Job): Promise<void>;
    work(kind: 'sync' | 'event', handler: (job: Job) => Promise<void>): Promise<void>;
    close(): Promise<void>;
}
export interface InvoiceFiles {
    put(messageId: string, kind: 'zip' | 'pdf', data: Uint8Array): Promise<void>;
    read(messageId: string, kind: 'zip' | 'pdf'): Promise<Buffer>;
}
export interface NotificationChannel {
    send(invoice: Invoice, eventId: string): Promise<void>;
}
export type Message = { id: string; tip: string; data_creare: string; detalii: string };
export interface AnafGateway {
    list(days: number): Promise<Message[]>;
    download(id: string): Promise<Uint8Array>;
    pdf(xml: Uint8Array): Promise<Uint8Array>;
}

export type ConnectionStatus = {
    state: 'mock' | 'unconfigured' | 'disconnected' | 'connected' | 'reconnect_required';
    canConnect: boolean;
    connectedAt: string | null;
};
