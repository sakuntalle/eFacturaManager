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
SMTP_HOST=127.0.0.1
ANAF_MOCK_URL=http://127.0.0.1:8790
```

The remaining example values are local-only defaults. Never add real credentials to `.env.example` or commit your `.env`.

Start PostgreSQL and the local email inbox, then create the administrator account:

```sh
docker compose --env-file .env up -d database mailpit
npm run admin:bootstrap
npm run dev
```

Open <http://localhost:5173>. Sign in as `admin` using the temporary password in `.local/admin/README.md`; the first login requires a password change. Mailpit is available at <http://localhost:8025>.

`npm run dev` starts the Vite frontend, NestJS API, worker and ANAF simulator with source watching. Do not run another worker against the same company at the same time.

## Build and tests

Run the fast checks:

```sh
npm run typecheck
npm test
npm run build
```

For browser tests with Google Chrome, start the app and run:

```sh
npm run test:browser
```

To use Playwright's Chromium instead:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:browser
```

The browser suite uses controlled API responses and does not need the real administrator password. Integration scripts and their prerequisites are described in the main [README](../README.md#run-during-development).

## Docker development build

To exercise the image built from the current checkout:

```sh
docker compose --env-file .env.example up -d database
DATABASE_URL=postgres://efactura:local-development@127.0.0.1:55432/efactura ANAF_MODE=mock ANAF_CIF=12345678 APP_PUBLIC_URL=http://localhost:3100 npm run admin:bootstrap
docker compose --env-file .env.example up --build -d
```

Open <http://localhost:3100>. Stop the stack with `docker compose --env-file .env.example down`; omit `-v` unless you intentionally want to delete the database and mock-data volumes.

This HTTP command is for mock development. A live ANAF connection must return to the exact registered OAuth callback. If the registered callback is `https://localhost:8765/callback`, keep the private live settings in `.env` and always include the HTTPS override when rebuilding or restarting the Docker development stack:

```sh
docker compose --env-file .env -f compose.yaml -f compose.https.yaml up -d --build
```

Open <https://localhost:8765>. Omitting `compose.https.yaml` leaves only the base HTTP configuration and prevents the registered HTTPS callback from completing. See the [live connection guide](live-connection.md) for certificate creation and the complete setup. The rebuild preserves named volumes; never add `-v` unless the database and mock data should be deleted.
