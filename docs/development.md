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

Before the first Docker launch, create and trust `.local/tls/localhost.pem` and `.local/tls/localhost-key.pem` using the [local HTTPS setup](local-https.md). If your `.env` previously used HTTP, update `APP_PUBLIC_URL` and `APP_TLS_PORT` using that guide's migration instructions.

Start Docker Desktop or the Docker daemon, then run the command for your platform from the project folder. Both helpers use your `.env`, build images, start the services, wait for health, and print the website address. They preserve existing volumes and require neither Node.js nor npm on the host. They start the stack; create the administrator separately on first installation as described below.

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

Both helpers accept `--no-build` to reuse built images and `--env-file .env.example` to select the example configuration:

```sh
./scripts/start-stack.sh --no-build --env-file .env.example
```

```powershell
.\scripts\start-stack.cmd --no-build --env-file .env.example
```

Use `--help` to display options. You can invoke either helper by its absolute path from any working directory; environment-file paths are relative to the project root.

To exercise the image built from the current checkout:

```sh
docker compose --env-file .env.example up -d database
DATABASE_URL=postgres://efactura:local-development@127.0.0.1:55432/efactura ANAF_MODE=mock ANAF_CIF=12345678 APP_PUBLIC_URL=https://localhost:8765 npm run admin:bootstrap
docker compose --env-file .env.example up --build -d
```

Open <https://localhost:8765>. Stop the stack with `docker compose --env-file .env.example down`; omit `-v` unless you intentionally want to delete the database and mock-data volumes.

The Docker development stack always uses HTTPS. A live ANAF connection must return to the exact registered OAuth callback. If the registered callback is `https://localhost:8765/callback`, keep the private live settings in `.env` when rebuilding or restarting it:

```sh
docker compose --env-file .env -f compose.yaml up -d --build
```

Open <https://localhost:8765>. See the [live connection guide](live-connection.md) for certificate creation and the complete setup. The rebuild preserves named volumes; never add `-v` unless the database and mock data should be deleted.
