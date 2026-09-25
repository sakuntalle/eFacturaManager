import { useEffect, useRef } from 'react';
import type { Invoice } from '../../app/contracts.js';

export function InvoiceDetails({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
    const panel = useRef<HTMLElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && !panel.current?.contains(active)) returnFocus.current = active;
        body.current?.scrollTo(0, 0);
        heading.current?.focus({ preventScroll: true });
    }, [invoice.id]);
    function close() {
        onClose();
        if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    }
    return <aside ref={panel} className="details" id="invoice-details" aria-labelledby="invoice-details-title"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
        <div className="details-header"><div><span className="eyebrow">INVOICE DETAILS</span>
            <h2 ref={heading} tabIndex={-1} id="invoice-details-title">Invoice {invoice.number}</h2></div>
            <button className="secondary" onClick={close} aria-label="Close invoice details">Close ×</button>
        </div>
        <div ref={body} className="details-body">
            <div className="detail-grid">
                <div className="detail-supplier"><span>Supplier</span><b>{invoice.supplier}</b><small>{invoice.supplierCif}</small></div>
                <div><span>Issue date</span><b>{invoice.issueDate}</b></div>
                <div><span>Due date</span><b>{invoice.dueDate || 'Not specified'}</b></div>
                <div><span>ANAF message</span><b>{invoice.messageId}</b></div>
            </div>
            <div className="table-scroll"><table><thead><tr><th>Description</th><th>Quantity</th><th>Net amount</th></tr></thead>
                <tbody>{invoice.lines.map((line, index) => <tr key={index}><td>{line.description}</td><td>{line.quantity}</td><td>{line.amount} {invoice.currency}</td></tr>)}</tbody>
            </table></div>
        </div>
        <div className="details-summary">
            <div className="totals"><span>Net {invoice.net} {invoice.currency}</span><span>VAT {invoice.tax} {invoice.currency}</span><b>Invoice amount {invoice.total} {invoice.currency}</b></div>
            <div className="details-downloads"><a className="document" href={`/api/invoices/${invoice.id}/zip`}>Download ZIP ↓</a>
                {invoice.pdfReady ? <a className="document" href={`/api/invoices/${invoice.id}/pdf`}>Download PDF ↓</a> : <span className="muted">Preparing PDF</span>}
            </div>
        </div>
    </aside>;
}
