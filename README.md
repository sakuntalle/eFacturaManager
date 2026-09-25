# eFactura Manager

A self-hosted TypeScript application for collecting and viewing Romanian e-Factura invoices. Development currently uses a local ANAF simulator. The React interface, NestJS API, PostgreSQL database, pg-boss workers, file storage and SMTP delivery are real components.

**ANAF mode and email delivery are independent.** `ANAF_MODE=mock` uses synthetic invoice data; it does not disable email. Point SMTP at a real provider to receive those notifications in a real inbox.

## Start with Docker

```sh
docker compose --env-file .env.example up --build -d
```

This explicitly uses the supplied local development configuration, avoiding any existing live credentials in `.env`.

- Application: <http://localhost:3100>
- Sign in: `admin@example.test` / `local-development-only`
- Local email inbox (Mailpit): <http://localhost:8025>

Check **Remember me** at sign-in to stay signed in for 30 days on that browser. Unchecked, the cookie lasts for the browser session and access expires after eight hours. Sessions persist across application restarts. Signing out revokes that session; changing the administrator credentials or session secret invalidates existing sessions. Some browsers restore session cookies when restoring a previous browsing session.

The first sync imports three synthetic invoices and generates their PDFs. Initial imports do **not** send individual invoice emails. In **Mocked ANAF**, choose **Create simulated invoice**, enter a supplier name and invoice amount in RON, and submit the form. Numbers increment automatically. Amounts accept a comma or dot and up to two decimal places; these custom simulated invoices use zero VAT. Then choose **Sync now** (or wait for the next scheduled poll). The invoice appears in the inbox, its PDF becomes available, and its notification arrives in Mailpit. Open **Activity** to inspect processing, retries and errors.

This is a local-first development version. Published ports bind to loopback. Default application/database credentials are local development values; replace them before hosting elsewhere. One administrator manages multiple companies and individuals in one workspace. Each entity has its own invoice archive, polling schedule, notification address and job history. Viewer accounts are not implemented.

The **Dark mode** switch stays in the top-right corner while scrolling and is also available on the sign-in page. The invoice form inherits the main UI theme without its own switch. The initial theme follows your system preference; your selection is saved in this browser.

The **Mocked ANAF** sidebar tab appears only when `ANAF_MODE=mock`. It groups simulator controls, mock notices and recent email notification statuses. In **Settings**, the administrator can add a Company (CIF/CUI) or Individual (CNP), edit its name, polling interval and notification address, and enable or disable its emails. The sidebar selector switches the inbox and activity view between entities.

The administrator can also delete the selected company or individual in **Settings**. A confirmation dialog explains that this permanently removes its stored invoices, ZIPs, PDFs and activity. The shared ANAF connection and other entities remain available. If the last entity is deleted, the app presents the add-entity form; deleted entities do not return after restart.


## Configure your own SMTP provider

Edit `.env` locally. Email transport is independent of `ANAF_MODE`, so keep your current ANAF connection and change only the mail settings:

```dotenv
EMAIL_ENABLED=true
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=your-smtp-username
SMTP_PASSWORD="your-smtp-password"
EMAIL_FROM="Your Company <invoices@your-domain.example>"
EMAIL_TO=your-initial-recipient@your-domain.example
```

Use the port, authentication and sender permitted by your provider. For implicit TLS on port 465 set `SMTP_SECURE=true`. TLS certificate verification remains enabled. `EMAIL_TO` seeds the original entity during migration or first startup; subsequent recipient changes belong in each entity’s Settings page. SMTP credentials remain deployment-wide in `.env`.

For a personal Gmail sending account, turn on 2-Step Verification and create a Google app password. Keep both the mailbox address and app password only in your local `.env`, with these values:

```dotenv
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=false
SMTP_USER=your-sending-address@gmail.com
SMTP_PASSWORD="your-16-character-app-password"
EMAIL_FROM="eFactura Manager <your-sending-address@gmail.com>"
EMAIL_TO=your-destination-address@example.com
```

Use the Gmail account as both `SMTP_USER` and the address in `EMAIL_FROM`; `EMAIL_TO` can be a different mailbox. The app password is separate from your Google account password. If Google does not offer app passwords for this account, use another SMTP provider rather than putting your normal password in `.env`.

After saving `.env`, run `npm run email:test` from the project directory. It sends one clearly labeled test message to `EMAIL_TO` using the same SMTP settings as invoice notifications. It prints only a generic success or failure and never prints the mailbox addresses or password. Then restart both the web and worker services as shown below so automatic notifications use the new settings.

Apply the configuration to the running HTTPS deployment (the worker sends the emails):

```sh
docker compose --env-file .env -f compose.yaml -f compose.https.yaml up -d --no-deps web worker
```

Mailpit is optional when `SMTP_HOST` points to an external provider. Once real delivery works, stop its local container with `docker compose --env-file .env -f compose.yaml -f compose.https.yaml stop mailpit`.

Then create a new simulated invoice in the Mocked ANAF tab. Emails are labeled **[SIMULATED ANAF]** and link back to the app. Set `APP_PUBLIC_URL` to the address the recipient can actually reach. A localhost link is usable only on the machine hosting the app.

`EMAIL_ENABLED=false` marks notification events as skipped; they can be replayed through Activity after enabling email. A failure to send email does not undo invoice collection or block its PDF. SMTP errors retry up to five attempts with exponential backoff, then become visible as failed work. Fix the settings and use Retry. SMTP acceptance is not proof of final inbox delivery.

## Run during development

Requires Node.js 24+, npm and Docker. Code uses four spaces, recorded in `.editorconfig`.

```sh
npm ci
docker compose --env-file .env.example up -d database mailpit
```

For native development copy the environment example to `.env`, set `SMTP_HOST=127.0.0.1`, and set `APP_PUBLIC_URL=http://localhost:5173`. Keep `ANAF_MOCK_URL=http://127.0.0.1:8790` and the default local database URL. If the full Docker stack is already running, stop only its application processes first:

```sh
docker compose stop web worker anaf-mock
npm run dev
```

Open <http://localhost:5173>. Vite serves the frontend and proxies API calls; NestJS, the worker and simulator reload on source changes. Do not run the native and Docker workers against the same company simultaneously during development.

Build and check:

```sh
npm run build
npm test
```

Verify the local Docker stack (not your real SMTP configuration):

```sh
docker compose --env-file .env.example up --build -d
npm run test:integration
npm run test:browser
```

The integration test requires the default mock company/admin and Mailpit recipient. It creates synthetic invoices and keeps them for inspection. Browser tests use installed Google Chrome through Playwright; alternatively set `PLAYWRIGHT_CHANNEL=chromium` and install Playwright's Chromium.

## Architecture

- `app/contracts.ts`: boundaries for persistence, queueing, ANAF, files and notification channels.
- `app/adapters/postgres.ts`: PostgreSQL schema/bootstrap migration and repository implementation. Invoice insertion and outbox creation share one transaction. Decimal amounts are preserved as strings in the invoice document.
- `app/adapters/queue.ts`: pg-boss implementation, retries and dead-letter queues. Workspace queues carry a company ID on every job.
- `app/workflows.ts`: synchronization, outbox publication and job execution. No SQL or pg-boss calls in business workflows.
- `app/adapters/anaf.ts`: HTTP adapter using the same list/download client for mock and live endpoints.
- `app/adapters/files.ts`: local storage implementation, scoped by mode/environment/company.
- `app/adapters/email.ts`: SMTP notification channel using Nodemailer.
- `app/api.ts`: NestJS API with local administrator sessions and request-origin checks.
- `app/worker.ts`: persistent job consumers and scheduler/outbox dispatcher.
- `app/mock/`: separate ANAF HTTP simulator with persistent synthetic invoices and failure controls.
- `web/`: React interface, built into static files served by NestJS.

A future database/queue combination needs implementations of the contracts, schema/data migrations and integration tests. The outbox does not rely on sharing a transaction with pg-boss, allowing a separate cloud queue later. No claim is made that an unimplemented database can be selected through configuration today.

### Delivery semantics

Invoice IDs are unique per company, and a completed outbox event is not reprocessed. Outbox publication is at least once: a crash after queue publication but before recording it can publish again. SMTP has an unavoidable ambiguity if a provider accepts a message immediately before the worker crashes; a replay may send another email. A stable Message-ID helps tracing but is not an exactly-once delivery guarantee.

Normal handler failures are retried by pg-boss; terminal failures also enter its dead-letter queue. The Activity screen replays failed application events as fresh queue jobs; it does not expose every provider-level DLQ operation. The default pg-boss retention policy applies to dead-letter messages. Historical success and failure records remain in the application outbox.

## Simulator coverage

Implemented endpoints: received-message listing, ZIP download and XML-to-PDF conversion. The ZIP contains a synthetic UBL-style invoice plus an explicitly invalid test signature. The PDF is generated locally and prominently labeled; it does not reproduce ANAF's layout. Fixtures are not claimed to pass CIUS-RO validation.

The Mocked ANAF tab can simulate HTTP 429, HTTP 503, an expired authorization (401), an invalid download response with HTTP 200, or a PDF conversion failure. Switch back to normal to exercise recovery. The invalid-download scenario is observable when a new, uncollected invoice exists. PDF failure affects pending PDF jobs; already generated PDFs remain available.

Mock mode uses a dedicated synthetic token and never forwards real ANAF tokens or client secrets to the simulator. Invoice data and files are separated by mode and fiscal identifier. The simulator seeds the original mock company; newly added mock entities begin empty and can receive simulated invoices. Its scenario selection resets to normal after restart.

## Live ANAF remains an integration milestone

`ANAF_MODE=live` uses one in-app ANAF connection for the workspace. Sign in with the administrator email/password, then choose **Connect to ANAF**. The browser opens ANAF certificate authorization and returns to the registered HTTPS `/callback`. The backend verifies access to the original CIF before saving the connection. The same certificate-backed token is used for each configured company or individual; ANAF must grant that certificate access to each fiscal identifier. Each entity’s first import suppresses individual invoice emails.

Connection status and Disconnect are under **Settings**. Signing out ends only the browser session. Disconnect deletes the locally stored authorization and stops future ANAF requests; it retains collected documents and does not revoke the grant at ANAF. A request already in flight may finish. Authorization failures display a reconnect prompt; temporary service errors retain the connection and retry.

Each deployment needs its own registration. Deployment credentials stay in server configuration and are never included in the status API or UI. The client identifier necessarily appears in the browser's authorization redirect to ANAF; the secret never does. Access/refresh tokens are encrypted with AES-256-GCM in PostgreSQL using a separate deployment key. Back up that key securely alongside your normal backup process; losing it requires reconnecting. Refresh is serialized across web and worker processes, and rotated refresh tokens are saved atomically. Legacy app access-token/token-file settings are no longer used.

See [live HTTPS setup](docs/live-connection.md). The retained [diagnostic CLI](docs/poc.md) is independent and is not required for the application flow. Its plaintext diagnostic token files are not imported by the app.

The integrated flow is tested against simulated OAuth responses over real local HTTPS and PostgreSQL. The qualified-certificate round trip and real invoice/PDF responses still need validation with ANAF. Listing is currently non-paginated and is not a complete archival/backfill implementation. The inbox shows up to 200 invoices in the selected date order.

The inbox defaults to sorting by ANAF Added date and time, newest first; both Added date and Issue date headings can reverse the order. Dates display as `DD/MM/YYYY`, and Added date includes the ANAF time as `HH:mm`. On upgrade, the worker revisits the available 60-day ANAF message list once per entity to fill time on previously collected invoices. If ANAF no longer lists an older message, the stored date remains visible with "time unavailable" rather than inventing a time.

## Data and operations

PostgreSQL stores parsed invoice details and the original ZIP and generated PDF bytes in a separate document table. The XML remains inside the ZIP and is extracted when needed. Back up the PostgreSQL database to preserve both invoice details and documents. The app no longer mounts or writes an `invoice-data` volume. Installations upgrading from an older version must migrate their legacy files into PostgreSQL before using this Compose configuration. `docker compose down` preserves volumes; `down -v` deletes them.

Administrator sessions are stored in PostgreSQL as token hashes with server-side expiry, behind a replaceable session-store contract. The current worker processes one job at a time per queue; jobs have a five-minute execution timeout. The ZIP is stored before committing its invoice/outbox record; a crash can leave an orphan document row, which a subsequent sync reuses. Full archival completeness, long-running job heartbeats and packaged backup/upgrade tooling are future work.

For cloud hosting later, substitute managed storage/queue adapters and add deployment-specific HTTPS, secret management and monitoring. Windows/Linux Docker compatibility follows the Linux-container packaging, but those host systems have not yet been separately exercised.

Invoice amounts in the inbox, details and notifications use the XML total including VAT (`TaxInclusiveAmount`), rather than the remaining balance (`PayableAmount`). Existing stored amounts are corrected from the XML inside their original ZIP once at startup, transactionally per company. This does not modify source documents or resend notifications. Missing or invalid source XML prevents the correction from committing. After `npm run build`, run `node scripts/invoice-totals-integration.mjs` with the local development database to verify migration rollback, concurrency and idempotency using isolated synthetic records. Run `npm run test:files` to verify database document storage and interrupted-migration recovery.
