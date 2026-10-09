# eFactura Manager

[![CI](https://github.com/sakuntalle/eFacturaManager/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/sakuntalle/eFacturaManager/actions/workflows/ci.yml)
[![License: GPL v3 or later](https://img.shields.io/badge/License-GPL_v3_or_later-blue.svg)](LICENSE)

A self-hosted TypeScript application for collecting and viewing Romanian e-Factura invoices. Development currently uses a local ANAF simulator. The React interface, NestJS API, PostgreSQL database, pg-boss workers, file storage and SMTP delivery are real components.

**ANAF mode and email delivery are independent.** `ANAF_MODE=mock` uses synthetic invoice data; it does not disable email. Point SMTP at a real provider to receive those notifications in a real inbox.

## Install a released version

The recommended non-developer installation uses Docker Desktop and a versioned image from GitHub Container Registry. It does not require Node.js or a source checkout.

1. Download `compose.release.yaml` and `.env.release.example` from the [latest release](https://github.com/sakuntalle/eFacturaManager/releases/latest).
2. Follow the [Docker Desktop installation guide](docs/docker-desktop.md) to generate local secrets, initialize the administrator and start the application.
3. Open <http://localhost:3100>.

Published images support Intel/AMD and Apple Silicon/ARM Linux containers. Releases are tagged as `ghcr.io/sakuntalle/efactura-manager:<version>`. After the first release workflow completes, the GHCR package must be made public in the repository owner's package settings so Docker Desktop users can pull it without authentication.

For source development, see [docs/development.md](docs/development.md). For live ANAF authorization, read [docs/live-connection.md](docs/live-connection.md) before adding private credentials.

## Build the current source with Docker

```sh
npm ci
docker compose --env-file .env.example up -d database
DATABASE_URL=postgres://efactura:local-development@127.0.0.1:55432/efactura ANAF_MODE=mock ANAF_CIF=12345678 APP_PUBLIC_URL=http://localhost:3100 npm run admin:bootstrap
docker compose --env-file .env.example up --build -d
```

This explicitly uses the supplied local development configuration, avoiding any existing live credentials in `.env`.

- Application: <http://localhost:3100>
- Sign in: username `admin`; read the unique 12-character temporary password in `.local/admin/README.md`
- Local email inbox (Mailpit): <http://localhost:8025>

The commands above intentionally use the public mock configuration and its HTTP endpoint. They are not suitable for completing a live ANAF authorization. ANAF redirects the browser to the exact callback registered for the OAuth application, including its scheme and port. When that callback is `https://localhost:8765/callback`, build and start an existing local HTTPS installation with both Compose files:

```sh
docker compose --env-file .env -f compose.yaml -f compose.https.yaml up -d --build
```

Then open <https://localhost:8765>. Always include `compose.https.yaml` when rebuilding or recreating this installation. Omitting it starts only the base HTTP configuration, which cannot receive the registered HTTPS callback. The command preserves the existing PostgreSQL and mock-data volumes; do not add `-v` when stopping the stack unless you intend to delete them.

The bootstrap command creates the one administrator account in PostgreSQL and writes its initial password to the local, Git-ignored README with owner-only file permissions. It generates the password once for a new database; rerunning the command leaves an existing account unchanged. The first login requires a password change before any workspace page or API can be used. After that change, the app opens **Manage ANAF connections**. A fresh workspace has no entities or connections: create a connection, add a company or individual linked to it, then authorize it in live mode. Existing installations retain their entities and connections. Use the same bootstrap command with your local `.env` when upgrading an existing installation. Never copy the local password README into a public repository.

### Switch the active database

The Docker web app and worker use the same `APP_DATABASE_NAME` from `.env`; the default is `efactura`. To create a separate, persistent workspace for first-login and live ANAF testing without changing the registered `https://localhost:8765/callback` URL:

```sh
npm run db:create -- efactura_onboarding
```

The command creates and initializes the named database on the local PostgreSQL server and writes its one-time administrator password to `.local/admin/efactura_onboarding/README.md`. It refuses to overwrite an existing database. Change `APP_DATABASE_NAME=efactura_onboarding` in `.env`, then apply the selection to both services:

```sh
docker compose --env-file .env -f compose.yaml -f compose.https.yaml up -d --no-deps --force-recreate web worker
```

Open the normal <https://localhost:8765> site and sign in with the new database's administrator password. The frontend, URL, ANAF callback and PostgreSQL volume stay the same; accounts, entities, invoices, sessions and saved ANAF connections belong to the selected database. To return to the original workspace, set `APP_DATABASE_NAME=efactura` and run the same Compose command. Neither switch deletes a database. For native development, `APP_DATABASE_NAME` selects the database in `DATABASE_URL` as well. Keep only one web/worker pair active for a selected database.

An alternative isolated first-login site can run from the current build on port 9878:

```sh
npm run build
npm run first-login:start
```

Open <https://localhost:9878>, sign in as `admin`, and read the generated temporary password in `.local/first-login-demo/admin/README.md`. This test instance starts with no managed entities or ANAF connections. It uses its own temporary PostgreSQL database, live ANAF mode and disabled email delivery. It does not start a worker, so it will not collect invoices automatically. To complete a real ANAF authorization, add `https://localhost:9878/callback` as another callback URL for your ANAF OAuth application; the normal app's `https://localhost:8765/callback` registration remains in place. When finished, run `npm run first-login:stop` to stop the test site and remove only its temporary database. Run `npm run first-login:start` again to repeat the flow with a fresh account. For a mock-only first-login test instead, use `npm run first-login:start:mock`, which opens <http://localhost:3201> and reports simulated ANAF access.

Check **Remember me** at sign-in to stay signed in for 30 days on that browser. Unchecked, the cookie lasts for the browser session and access expires after eight hours. Sessions persist across application restarts. Signing out revokes that session; changing the administrator password revokes all existing sessions. Some browsers restore session cookies when restoring a previous browsing session.

After adding a connection and a managed entity in mock mode, the first sync imports three synthetic invoices and generates their PDFs. Initial imports do **not** send individual invoice emails. In **Mocked ANAF**, choose **Create simulated invoice**, enter a supplier name and invoice amount in RON, and submit the form. Numbers increment automatically. Amounts accept a comma or dot and up to two decimal places; these custom simulated invoices use zero VAT. Then choose **Sync now** (or wait for the next scheduled poll). The invoice appears in the inbox, its PDF becomes available, and its notification arrives in Mailpit. Open **Activity** to inspect processing, retries and errors.

This is a local-first development version. Published ports bind to loopback. Default database credentials and session secret are local development values; replace them before hosting elsewhere. One administrator manages multiple companies and individuals in one workspace. Each entity has its own invoice archive, polling schedule, notification address and job history. Viewer accounts are not implemented.

The **Dark mode** switch is anchored in the top-right header on every page, including sign-in and account recovery. The invoice form inherits the main UI theme without its own switch. The initial theme follows your system preference; your selection is saved in this browser.

The sidebar always shows **Managed companies** and **Managed individuals**. Select an entity, then use the **Invoices**, **Activity** and **Settings** tabs above the main view. **Manage ANAF connections** lists authorizations, their status and linked entities; it can create another connection and open the entity form with that connection selected. **Add managed entity** opens the Company (CIF/CUI) or Individual (CNP) creation form, where the ANAF connection is selected. An entity’s connection can also be changed in its Settings. The **Mocked ANAF** tab appears only when `ANAF_MODE=mock` and groups simulator controls and recent notification statuses. The bottom-left profile identifies the administrator.

The in-app **Back** button returns to the previous workspace view, including the selected entity and tab. It works when moving through sidebar items, entity tabs, connection links and the add-entity form.

The administrator can also delete the selected company or individual in **Settings**. A confirmation dialog explains that this permanently removes its stored invoices, ZIPs, PDFs and activity. ANAF connections and other entities remain available. If the last entity is deleted, **Add managed entity** remains available; deleted entities do not return after restart.


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

### Recover the administrator password

Use **Forgot password?** on the sign-in page and enter an email address saved as the notification recipient for any managed company or individual. The application gives the same response for matching and non-matching addresses. It sends a reset link only to the matching address stored in PostgreSQL, using the deployment SMTP settings. `EMAIL_TO` in `.env` alone does not qualify until it is saved on a managed entity. The link expires after 30 minutes and works once; changing the password revokes all existing sessions and pending reset links. The reset email is independent of the entity's **Send invoice emails** setting.

Anyone who controls any managed entity's notification mailbox can reset the single global administrator account and access every entity. Configure those recipient addresses accordingly. The link uses `APP_PUBLIC_URL`, so a localhost URL only opens from the host machine. If the database has no managed entities yet, use the initial administrator password in that database's local README.

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
docker compose --env-file .env.example up -d database
DATABASE_URL=postgres://efactura:local-development@127.0.0.1:55432/efactura ANAF_MODE=mock ANAF_CIF=12345678 APP_PUBLIC_URL=http://localhost:3100 npm run admin:bootstrap
docker compose --env-file .env.example up --build -d
npm run test:admin
npm run test:reset
npm run test:entities
npm run test:connection
npm run test:browser
```

The isolated admin, entity and connection tests use temporary databases and do not change the running app's credentials or invoice data. All Playwright browser tests use controlled API responses and run without an administrator password; they do not change the running app's entities or invoices. For the normal HTTPS app, run `PLAYWRIGHT_BASE_URL=https://localhost:8765 npm run test:browser`. The optional `test:integration` uses the local mock stack and requires `TEST_ADMIN_PASSWORD` to be set to its current administrator password. Browser tests use installed Google Chrome through Playwright; alternatively set `PLAYWRIGHT_CHANNEL=chromium` and install Playwright's Chromium.

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

`ANAF_MODE=live` supports multiple in-app ANAF connections. Existing entities and the saved authorization remain linked to **Primary ANAF connection** after upgrade. Sign in as `admin`, change the temporary password if prompted, then open **Manage ANAF connections**. One connection can serve multiple entities when its certificate has access to their fiscal identifiers. To use another authorization, create a named connection, add or assign an entity to it, then connect through the browser with the appropriate certificate. The backend verifies access to the first linked fiscal identifier before saving that connection. Each entity’s first import suppresses individual invoice emails.

Connection status, Connect, Reconnect and Disconnect are under **Manage ANAF connections**, separate from entity Settings. Signing out ends only the browser session. Disconnect deletes that connection’s locally stored authorization and pauses collection for its linked entities; other connections continue working. It retains collected documents and does not revoke the grant at ANAF. A request already in flight may finish. Authorization failures display a reconnect prompt; temporary service errors retain the connection and retry.

Each deployment needs its own registration. Deployment credentials stay in server configuration and are never included in the status API or UI. The client identifier necessarily appears in the browser's authorization redirect to ANAF; the secret never does. Access/refresh tokens are encrypted with AES-256-GCM in PostgreSQL using a separate deployment key. Back up that key securely alongside your normal backup process; losing it requires reconnecting. Refresh is serialized across web and worker processes, and rotated refresh tokens are saved atomically. Legacy app access-token/token-file settings are no longer used.

See [live HTTPS setup](docs/live-connection.md). The retained [diagnostic CLI](docs/poc.md) is independent and is not required for the application flow. Its plaintext diagnostic token files are not imported by the app.

The integrated flow is tested against simulated OAuth responses over real local HTTPS and PostgreSQL. The qualified-certificate round trip and real invoice/PDF responses still need validation with ANAF. ANAF message listing is currently non-paginated and is not a complete archival/backfill implementation. The stored invoice inbox is paginated at 50 invoices per page.

The inbox defaults to sorting by ANAF Added date and time, newest first; both Added date and Issue date headings can reverse the order. Dates display as `DD/MM/YYYY`, and Added date includes the ANAF time as `HH:mm`. On upgrade, the worker revisits the available 60-day ANAF message list once per entity to fill time on previously collected invoices. If ANAF no longer lists an older message, the stored date remains visible with "time unavailable" rather than inventing a time.

Invoice rows can be selected individually or across all pages with **Select all**. The selected original ZIPs can be downloaded inside one ZIP archive; selected generated PDFs can be downloaded the same way once every selected PDF is ready. There is no application-level document-count limit on a bundle.

## Data and operations

PostgreSQL stores parsed invoice details and the original ZIP and generated PDF bytes in a separate document table. The XML remains inside the ZIP and is extracted when needed. Back up the PostgreSQL database to preserve both invoice details and documents. The app no longer mounts or writes an `invoice-data` volume. Installations upgrading from an older version must migrate their legacy files into PostgreSQL before using this Compose configuration. `docker compose down` preserves volumes; `down -v` deletes them.

Administrator sessions are stored in PostgreSQL as token hashes with server-side expiry, behind a replaceable session-store contract. The current worker processes one job at a time per queue; jobs have a five-minute execution timeout. The ZIP is stored before committing its invoice/outbox record; a crash can leave an orphan document row, which a subsequent sync reuses. Full archival completeness, long-running job heartbeats and packaged backup/upgrade tooling are future work.

To diagnose failures, run `docker compose --env-file .env -f compose.yaml -f compose.https.yaml logs --tail 200 web worker`. Structured JSON log entries show the module, failing stage, a stable opaque entity reference, and allowlisted HTTP, database or network codes. The selected entity’s reference appears in Settings. Logs omit raw ANAF responses, OAuth values, invoice contents, fiscal identifiers and SMTP error text. Successful syncs log their imported invoice count and duration.

For cloud hosting later, substitute managed storage/queue adapters and add deployment-specific HTTPS, secret management and monitoring. Windows/Linux Docker compatibility follows the Linux-container packaging, but those host systems have not yet been separately exercised.

Invoice amounts in the inbox, details and notifications use the XML total including VAT (`TaxInclusiveAmount`), rather than the remaining balance (`PayableAmount`). Existing stored amounts are corrected from the XML inside their original ZIP once at startup, transactionally per company. This does not modify source documents or resend notifications. Missing or invalid source XML prevents the correction from committing. After `npm run build`, run `node scripts/invoice-totals-integration.mjs` with the local development database to verify migration rollback, concurrency and idempotency using isolated synthetic records. Run `npm run test:files` to verify database document storage and interrupted-migration recovery.

## Contributing, security and license

Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Releases are published manually by the repository owner. The maintainer workflow and required GitHub branch rules are documented in [docs/releasing.md](docs/releasing.md).

Copyright © 2026 Mihnea Magheru. This project is free software licensed under [GNU GPL version 3 or later](LICENSE). It is provided without warranty; review the license and deployment guidance before using it with production data.
