import { useState } from 'react';
import type { ConnectionStatus } from '../../app/contracts.js';
import { formatAppDateTime } from './invoice-date.js';

export function AnafConnectionCard({ connection, busy, onDisconnect }: {
    connection: ConnectionStatus; busy: boolean; onDisconnect: () => void;
}) {
    const [confirm, setConfirm] = useState(false);
    const connected = connection.state === 'connected';
    return <section className="card settings-card connection-card" aria-labelledby="anaf-connection-title">
        <span className="eyebrow">WORKSPACE CONNECTION</span>
        <h2 id="anaf-connection-title">{connected ? 'Connected to ANAF' : connection.state === 'reconnect_required' ? 'Reconnect to ANAF' : 'Connect your workspace to ANAF'}</h2>
        {connection.state === 'unconfigured' ? <p role="status">ANAF connection is not available yet. Ask the deployment administrator to complete the server setup.</p>
            : connected ? <><p>One certificate authorization serves all configured entities that ANAF permits this certificate to access. Invoices are collected automatically while the worker is running.</p>
                {connection.connectedAt && <p className="muted">Connected on {formatAppDateTime(connection.connectedAt)}.</p>}
                {confirm ? <div><p>Disconnect this workspace? Collection will stop for every entity. Downloaded invoices will remain available.</p>
                    <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
                        <button className="primary" disabled={busy} onClick={() => { setConfirm(false); onDisconnect(); }}>Confirm disconnect</button></div></div>
                    : <button className="secondary" disabled={busy} onClick={() => setConfirm(true)}>Disconnect ANAF</button>}</>
                : <><p>Use your qualified certificate in the ANAF browser window to authorize access for this workspace. ANAF checks that certificate’s access for each fiscal identifier during collection.</p>
                    <p className="muted">The first synchronization for each entity imports available invoices without sending an email for each existing invoice.</p>
                    <form method="post" action="/api/anaf/connect"><button className="primary" disabled={busy || !connection.canConnect}>
                        {connection.state === 'reconnect_required' ? 'Reconnect to ANAF' : 'Connect to ANAF'} →</button></form></>}
    </section>;
}
