# Operations and troubleshooting

This guide covers backups, upgrades, account recovery and diagnostics. For installation and everyday use, start with the [README](../README.md).

## Service commands

Run these commands from the release installation folder:

```sh
docker compose --env-file .env -f compose.release.yaml ps
docker compose --env-file .env -f compose.release.yaml logs --tail 200 web worker
docker compose --env-file .env -f compose.release.yaml down
```

For a source checkout, use `-f compose.yaml` instead. The [development guide](development.md#docker-development-build) describes the startup helpers and build options.

The default installation binds ports to the current computer only. Hosting elsewhere needs deployment-specific HTTPS, access controls and an exact registered ANAF callback. See [the live connection guide](live-connection.md).

## Backups and release updates

Back up PostgreSQL and the `app-secrets` volume together. PostgreSQL contains the entities, invoices, original ZIPs, generated PDFs, accounts and encrypted connection settings. The `app-secrets` volume contains the keys needed to use those encrypted settings and retain sessions. Keep `.env`, `.local` and backups private.

Application restarts and image updates preserve the named volumes. `docker compose down -v` permanently deletes the database and application-secrets volumes. Backups and restoration are currently operator-managed; the app does not provide packaged backup tooling.

Before an update, read the release notes and back up the data. Change `EFACTURA_VERSION` in `.env` to the desired release, then run:

```sh
docker compose --env-file .env -f compose.release.yaml pull
docker compose --env-file .env -f compose.release.yaml up -d --wait
```

Keep the same database and application-secrets volumes. Losing the encryption keys requires reconnecting ANAF. Source deployments use the startup helpers to detect changed build inputs and rebuild when needed.

## Empty inbox or connection problems

1. Check the selected entity and its linked authorization under **Manage ANAF connections**.
2. Confirm that the installation has its ANAF application registration configured and that the certificate has access to the entity's fiscal identifier.
3. Check **Activity** for synchronization errors. Use **Sync now** to request another synchronization; work runs in the background.
4. If the app requests reconnection, reconnect that authorization. Temporary service errors retain the connection and retry automatically.

Signing out ends the browser session. Disconnecting an ANAF connection deletes its locally stored authorization and pauses collection for linked entities, while preserving collected documents and other connections. It does not revoke the grant at ANAF. An in-flight request or an existing email job may still finish.

Live authorization and invoice retrieval have been verified with real company invoices. Automated connection tests use simulated ANAF responses over real local HTTPS and PostgreSQL; they do not exercise the real certificate provider. The diagnostic CLI described in [docs/poc.md](poc.md) is independent of the app and is not needed for normal setup.

## Email settings and delivery

The SMTP sender is shared by all entities and configured under **Email settings**. Each entity has its own notification recipient and **Send E-invoice notification emails** switch. A configured SMTP sender is required to enable that switch. Saved SMTP credentials are encrypted in PostgreSQL; leaving the password blank retains the saved password for the same username.

On upgrade, complete legacy `.env` SMTP settings are imported only if no sender has been saved in the app. The import reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD` and `EMAIL_FROM`. Existing in-app settings take precedence; entity recipients and notification switches are preserved. Fresh installations have no implicit local mail server.

Email failures do not undo invoice collection or block PDF storage. Failed sends retry up to five attempts with exponential backoff, then appear as failed work in **Activity**. Correct the settings and use **Retry**. Notifications skipped while an entity's switch was off can also be retried. SMTP acceptance does not guarantee final inbox delivery; a retry after an interrupted send can produce a duplicate email. See [delivery semantics](architecture.md#delivery-semantics).

## Administrator access and recovery

One administrator manages the entire workspace. **Remember me** keeps a session for 30 days; otherwise access expires after eight hours and the cookie is a browser-session cookie. Sessions survive app restarts. Signing out revokes the current session; changing the administrator password revokes all sessions. Some browsers restore session cookies when restoring a previous browsing session.

Use **Forgot password?** and an email address saved as an entity's notification recipient. Recovery requires configured SMTP and a matching stored recipient. It works even when that entity's notification switch is off. A reset link expires after 30 minutes and can be used once. The reset page gives the same response for matching and non-matching email addresses.

Anyone who controls any managed entity's notification mailbox can reset the shared administrator account and access every entity. Configure those recipients accordingly. `EMAIL_TO` in `.env` alone does not qualify; the address must be saved on an entity. Reset links use `APP_PUBLIC_URL`, so a localhost link opens on the installation's computer. The generated temporary password applies only before the first password change.

## Upgrading older installations

- Original ZIPs and generated PDFs now live in PostgreSQL. Older file-based installations must complete their document migration; preserve the legacy files until migration succeeds. Missing source files prevent startup from completing the migration.
- Existing entities and the saved authorization remain linked to **Primary ANAF connection**. Other authorizations can be added and entities reassigned in Settings.
- Legacy `APP_SESSION_SECRET` and `ANAF_TOKEN_ENCRYPTION_KEY` settings are migration inputs. Keep them during the first upgrade so existing sessions and authorizations remain readable. New installations generate their application keys automatically.
- Invoice amounts use the XML total including VAT (`TaxInclusiveAmount`), rather than the remaining balance (`PayableAmount`). Existing amounts are corrected from archived XML once at startup, transactionally per company. This does not modify original documents or resend notifications. Missing or invalid XML prevents the correction from committing.
- The worker revisits the available 60-day ANAF message list once per entity to fill missing Added times. Older records that ANAF no longer lists display "time unavailable" rather than an invented time.

## Diagnostics and current limits

Structured logs contain the module, failure stage, an opaque entity reference and allowlisted HTTP/database/network codes. Settings shows the selected entity's diagnostic reference. Logs omit raw ANAF responses, OAuth values, invoice contents, fiscal identifiers and SMTP error text. Keep credentials, tokens, cookies, raw callback URLs and private documents out of support requests.

The invoice inbox is paginated at 50 invoices per page. Date headings can change the sort order, and columns can be resized. **Select all** supports downloads across all matching pages. ZIP bundles include the original archives or available generated PDFs, depending on the selected download action.

ANAF collection is not a complete historical archival/backfill implementation. The worker currently processes one job at a time per queue, with a five-minute job timeout. A crash between document storage and transaction completion can leave an orphan document row, which a subsequent synchronization reuses. Full archival completeness and long-running job heartbeats remain future work.

Release images support Linux containers on AMD64 and ARM64. Windows and Linux host behavior has not yet been separately exercised to the same extent as the local macOS setup. The project has not undergone an independent security audit.
