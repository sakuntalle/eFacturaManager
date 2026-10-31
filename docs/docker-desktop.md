# Install a released version with Docker Desktop

This path runs a published image and does not require Git, Node.js or a source checkout. Docker Desktop must be installed and running.

## Download and configure

1. Open the [latest release](https://github.com/sakuntalle/eFacturaManager/releases/latest).
2. Create an empty folder for the installation.
3. Download `compose.yaml`, `compose.release.yaml` and `env.release.example` from the release assets into that folder. Keep both Compose files together; `compose.release.yaml` inherits shared service settings from `compose.yaml`.
4. Rename `env.release.example` to `.env`. Release assets already contain the matching image version; for the first release this is `EFACTURA_VERSION=1.0.0` from tag `v1.0.0`.
5. Set `POSTGRES_PASSWORD` to a random value. The application generates and persists its session and encryption keys automatically. This command prints a suitable database password:

    ```sh
    docker run --rm node:24-alpine node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
    ```

6. Create the private folder that will receive the one-time administrator password:

    macOS/Linux:

    ```sh
    mkdir -p .local/admin
    ```

    Windows PowerShell:

    ```powershell
    New-Item -ItemType Directory -Force .local/admin
    ```

Keep `.env` and `.local` private. They contain deployment secrets or the initial administrator password and must not be uploaded to GitHub, cloud drives or support tickets.

Before starting the stack, create locally trusted certificates at `.local/tls/localhost.pem` and `.local/tls/localhost-key.pem` using the [local HTTPS setup](local-https.md). When upgrading from an HTTP release, update the existing `.env` using that guide's migration instructions.

## Start the application

From that folder, run:

```sh
docker compose --env-file .env -f compose.release.yaml pull
docker compose --env-file .env -f compose.release.yaml up -d database
docker compose --env-file .env -f compose.release.yaml --profile tools run --rm admin-bootstrap
docker compose --env-file .env -f compose.release.yaml up -d
```

Open <https://localhost:8765> and sign in as `admin` with the temporary password stored in `.local/admin/README.md`. You must change it on first login. Open **Email settings** to configure SMTP.

The installation binds its ports to the current computer only. Add an ANAF connection and managed entity, then authorize the connection before synchronizing. Email delivery remains disabled until SMTP is configured.

Check service state with:

```sh
docker compose --env-file .env -f compose.release.yaml ps
```

## Update to another release

Back up the PostgreSQL database first. Then change `EFACTURA_VERSION` in `.env` to the new release number and run:

```sh
docker compose --env-file .env -f compose.release.yaml pull
docker compose --env-file .env -f compose.release.yaml up -d
```

Keep the same `.env`, database volume and `app-secrets` volume when upgrading. Review the release notes for migration or compatibility instructions.

## Stop or remove

Stop the application while retaining all data:

```sh
docker compose --env-file .env -f compose.release.yaml down
```

Do not add `-v` unless you intentionally want to permanently delete the PostgreSQL and application-secrets volumes.

## HTTPS and live ANAF

The release always uses HTTPS. Create locally trusted certificates before starting it, then follow [the live connection guide](live-connection.md) to configure ANAF. The standard release command already starts the HTTPS listener at <https://localhost:8765> and preserves the database volume.

This project has not undergone an independent security audit. Back up the database and encryption key, restrict access to the host and review the deployment for your environment before storing production invoice data.
