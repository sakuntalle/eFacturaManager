# Architecture

The application uses TypeScript, NestJS, React, PostgreSQL and pg-boss. The web app, worker and database run as separate services.

## Main components

- `app/contracts.ts`: boundaries for persistence, queueing, ANAF, files and notification channels.
- `app/adapters/postgres.ts`: PostgreSQL schema/bootstrap migration and repository implementation. Invoice insertion and outbox creation share one transaction. Decimal amounts are preserved as strings in the invoice document.
- `app/adapters/queue.ts`: pg-boss implementation, retries and dead-letter queues. Workspace queues carry a company ID on every job.
- `app/workflows.ts`: synchronization, outbox publication and job execution. No SQL or pg-boss calls in business workflows.
- `app/adapters/anaf.ts`: HTTP adapter for authorized ANAF list, download and PDF requests.
- `app/adapters/files.ts`: PostgreSQL-backed invoice document storage. The local file adapter remains for legacy migration and diagnostic tooling.
- `app/adapters/email.ts`: SMTP notification channel using Nodemailer.
- `app/api.ts`: NestJS API with local administrator sessions and request-origin checks.
- `app/worker.ts`: persistent job consumers and scheduler/outbox dispatcher.
- `app/secrets.ts`: persistent application keys shared by web and worker processes.
- `app/smtp-settings.ts`: validation and public representation of SMTP settings.
- `web/`: React interface, built into static files served by NestJS.

A future database/queue combination needs implementations of the contracts, schema/data migrations and integration tests. The outbox does not rely on sharing a transaction with pg-boss, allowing a separate cloud queue later. No claim is made that an unimplemented database can be selected through configuration today.

### Delivery semantics

Invoice IDs are unique per company, and a completed outbox event is not reprocessed. Outbox publication is at least once: a crash after queue publication but before recording it can publish again. SMTP has an unavoidable ambiguity if a provider accepts a message immediately before the worker crashes; a replay may send another email. A stable Message-ID helps tracing but is not an exactly-once delivery guarantee.

Normal handler failures are retried by pg-boss; terminal failures also enter its dead-letter queue. The Activity screen replays failed application events as fresh queue jobs; it does not expose every provider-level DLQ operation. The default pg-boss retention policy applies to dead-letter messages. Historical success and failure records remain in the application outbox.


For setup and test commands, see [Local development](development.md). For backups, upgrades and recovery, see [Operations](operations.md).
