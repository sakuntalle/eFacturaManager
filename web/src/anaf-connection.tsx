import { useState } from 'react';
import type { ConnectionStatus } from '../../app/contracts.js';

export function AnafConnectionCard({ connection, cif, busy, onDisconnect }: {
    connection: ConnectionStatus; cif: string; busy: boolean; onDisconnect: () => void;
}) {
    const [confirm, setConfirm] = useState(false);
    const connected = connection.state === 'connected';
    return <section className="card settings-card connection-card" aria-labelledby="anaf-connection-title">
        <span className="eyebrow">COMPANY CONNECTION</span>
        <h2 id="anaf-connection-title">{connected ? 'Connected to ANAF' : connection.state === 'reconnect_required' ? 'Reconnect to ANAF' : 'Connect your company to ANAF'}</h2>
        <p>CIF <strong>{cif}</strong></p>
        {connection.state === 'unconfigured' ? <p role="status">ANAF connection is not available yet. Ask the deployment administrator to complete the server setup.</p>
            : connected ? <><p>Invoices are collected automatically while the worker is running. Signing out of this app keeps collection active.</p>
                {connection.connectedAt && <p className="muted">Connected on {new Date(connection.connectedAt).toLocaleString()}.</p>}
                {confirm ? <div><p>Disconnect this company? Collection will stop. Downloaded invoices will remain available.</p>
                    <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
                        <button className="primary" disabled={busy} onClick={() => { setConfirm(false); onDisconnect(); }}>Confirm disconnect</button></div></div>
                    : <button className="secondary" disabled={busy} onClick={() => setConfirm(true)}>Disconnect ANAF</button>}</>
                : <><p>Use your qualified certificate in the ANAF browser window to authorize invoice access for this company. You only need to repeat this when authorization needs renewing.</p>
                    <p className="muted">The first synchronization imports available invoices without sending an email for each existing invoice.</p>
                    <form method="post" action="/api/anaf/connect"><button className="primary" disabled={busy || !connection.canConnect}>
                        {connection.state === 'reconnect_required' ? 'Reconnect to ANAF' : 'Connect to ANAF'} →</button></form></>}
    </section>;
}
