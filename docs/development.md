# Local development

## Prerequisites

- Node.js 24 or newer
- npm
- Docker Desktop, or Docker Engine with Compose v2
- Git
- Google Chrome for the default Playwright configuration, or Playwright Chromium

## First-time setup

Clone the repository and install the locked dependencies:

```sh
git clone https://github.com/sakuntalle/eFacturaManager.git
cd eFacturaManager
npm ci
cp .env.example .env
```

On Windows PowerShell, replace the last command with `Copy-Item .env.example .env`.

For native development, edit `.env` and set:

```dotenv
APP_PUBLIC_URL=http://localhost:5173
DATABASE_URL=postgres://efactura:<your-password>@127.0.0.1:55432/efactura
DATA_DIR=.local/app
```

Set POSTGRES_PASSWORD in .env before starting PostgreSQL. Configure SMTP under Email settings after signing in. Never add real credentials to `.env.example` or commit your `.env`.

Start PostgreSQL, then create the administrator account:

```sh
docker compose --env-file .env up -d database
npm run admin:bootstrap
npm run dev
```

Open <http://localhost:5173>. Sign in as `admin` using the temporary password in `.local/admin/README.md`; the first login requires a password change.

`npm run dev` starts the Vite frontend, NestJS API and worker with source watching. Do not run another worker against the same company at the same time.

## Build and tests

Run the fast checks:

```sh
npm run typecheck
npm test
npm run build
```

For browser tests with Google Chrome, build the app and run:

```sh
npm run test:browser
```

To use Playwright's Chromium instead:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:browser
```

The browser suite uses controlled API responses and does not need the real administrator password. See [Integration checks](#integration-checks) for database and HTTPS tests.

## Docker development build

A Docker source installation needs Git, Docker and locally trusted HTTPS certificates. Node.js and npm on the host are only needed for native development and local test commands.

Clone the repository if needed and create `.env` from `.env.example` (`Copy-Item .env.example .env` in Windows PowerShell). Set a random `POSTGRES_PASSWORD`, `APP_PUBLIC_URL=https://localhost:8765` and `APP_TLS_PORT=8765`. See [the live connection guide](live-connection.md) for the ANAF application registration.

Before the first Docker launch, create and trust `.local/tls/localhost.pem` and `.local/tls/localhost-key.pem` using the [local HTTPS setup](local-https.md). If your `.env` previously used HTTP, update `APP_PUBLIC_URL` and `APP_TLS_PORT` using that guide's migration instructions.

Create `.local/admin` (`mkdir -p .local/admin` on macOS/Linux or `New-Item -ItemType Directory -Force .local/admin` in Windows PowerShell). Start Docker Desktop or the Docker daemon, then initialize the database and administrator:

```sh
docker compose --env-file .env up -d database
docker compose --env-file .env --profile tools run --rm admin-bootstrap
```

Run the command for your platform from the project folder. Both helpers use your `.env`, start the services, wait for health, and print the website address. They compare the current Docker build inputs with a fingerprint stored inside the application image. Changed source, assets, dependencies, build configuration or branch contents trigger a rebuild; unchanged inputs reuse the image. Missing images and older images without a fingerprint are built automatically. The comparison runs in a disposable container with no network access and a read-only source mount. It excludes `.env`, local data and files outside the Docker build inputs. Unchanged running containers are kept; stopped containers are started. Compose may recreate a container if its configuration or image has changed. Existing volumes are preserved. The helpers require neither Node.js nor npm on the host. They start the stack; create the administrator separately on first installation as described below.

On macOS or Linux:

```sh
./scripts/start-stack.sh
```

On Windows PowerShell, with Docker Desktop running Linux containers:

```powershell
.\scripts\start-stack.cmd
```

On Windows Command Prompt:

```bat
scripts\start-stack.cmd
```

Windows users can also double-click `scripts\start-stack.cmd` in File Explorer. If startup fails, the window waits for a keypress so the error remains visible. Add `--no-pause` when using the Windows helper in automation; failure still returns a nonzero exit code. The Windows helper does not require Bash, WSL, or a PowerShell execution-policy change.

For normal starts, including after source changes or branch switches, no build flag is needed. Use `--build` to force a build. Both helpers accept `--no-build` to skip the comparison and prohibit building even when an image is missing, and `--env-file <file>` to select another configured environment file:

```sh
./scripts/start-stack.sh --build --env-file .env
```

```powershell
.\scripts\start-stack.cmd --build --env-file .env
```

Use `--help` to display options. You can invoke either helper by its absolute path from any working directory; environment-file paths are relative to the project root.

After pulling source updates, a normal start detects changed build inputs and rebuilds the application as needed. A connection without a linked entity is valid during onboarding and must not prevent the web app or worker from starting.

To exercise the image built from the current checkout:

```sh
docker compose --env-file .env up -d database
docker compose --env-file .env --profile tools run --rm admin-bootstrap
docker compose --env-file .env up --build -d
```

Open <https://localhost:8765>. Stop the stack with `docker compose --env-file .env down`; omit `-v` unless you intentionally want to delete the database and application-secrets volumes.

The Docker development stack always uses HTTPS. A live ANAF connection must return to the exact registered OAuth callback. If the registered callback is `https://localhost:8765/callback`, keep the private live settings in `.env` when rebuilding or restarting it:

```sh
docker compose --env-file .env -f compose.yaml up -d --build
```

Open <https://localhost:8765>. See the [live connection guide](live-connection.md) for certificate creation and the complete setup. The rebuild preserves named volumes; never add `-v` unless the database and application secrets should be deleted.

Native HTTP development supports UI work and stored documents; use the HTTPS Docker setup for qualified-certificate authorization. Session and token-encryption keys are created automatically in APP_SECRETS_DIR and must be retained across restarts.

## Integration checks

With local PostgreSQL configured through `DATABASE_URL` in `.env`, run:

```sh
npm run test:admin
npm run test:reset
npm run test:entities
npm run test:files
npm run test:smtp
npm run test:connection
```

These checks use temporary databases and synthetic data. The connection test also requires the local mkcert certificates and Chrome. It builds the app and exercises real browser interactions against a local HTTPS authorization provider; ANAF requests are intercepted and do not contact the real service.

After building, `node --env-file=.env scripts/invoice-totals-integration.mjs` checks invoice amount migration rollback, concurrency and idempotency. See [Operations](operations.md#upgrading-older-installations) for the migration behavior.

## Switch the active database


The Docker web app and worker use the same `APP_DATABASE_NAME` from `.env`; the default is `efactura`. To create a separate, persistent workspace for first-login and live ANAF testing without changing the registered `https://localhost:8765/callback` URL:

```sh
npm run db:create -- efactura_onboarding
```

The command creates and initializes the named database on the local PostgreSQL server and writes its one-time administrator password to `.local/admin/efactura_onboarding/README.md`. It refuses to overwrite an existing database. Change `APP_DATABASE_NAME=efactura_onboarding` in `.env`, then apply the selection to both services:

```sh
docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate web worker
```

Open the normal <https://localhost:8765> site and sign in with the new database's administrator password. The frontend, URL, ANAF callback and PostgreSQL volume stay the same; accounts, entities, invoices, sessions and saved ANAF connections belong to the selected database. To return to the original workspace, set `APP_DATABASE_NAME=efactura` and run the same Compose command. Neither switch deletes a database. For native development, `APP_DATABASE_NAME` selects the database in `DATABASE_URL` as well. Keep only one web/worker pair active for a selected database.

An alternative isolated first-login site can run from the current build on port 9878:

```sh
npm run build
npm run first-login:start
```

Open <https://localhost:9878>, sign in as `admin`, and read the generated temporary password in `.local/first-login-demo/admin/README.md`. This test instance starts with no managed entities or ANAF connections. It uses its own temporary PostgreSQL database, live ANAF mode and disabled email delivery. It does not start a worker, so it will not collect invoices automatically. To complete a real ANAF authorization, add `https://localhost:9878/callback` as another callback URL for your ANAF OAuth application; the normal app's `https://localhost:8765/callback` registration remains in place. When finished, run `npm run first-login:stop` to stop the test site and remove only its temporary database. Run `npm run first-login:start` again to repeat the flow with a fresh account.

See [Architecture](architecture.md) for component boundaries and delivery semantics.
