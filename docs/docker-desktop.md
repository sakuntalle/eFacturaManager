# Install a released version with Docker Desktop

This path runs a published image and does not require Git, Node.js or a source checkout. Docker Desktop must be installed and running.

## Download and configure

1. Open the [latest release](https://github.com/sakuntalle/eFacturaManager/releases/latest).
2. Create an empty folder for the installation.
3. Download `compose.release.yaml` and `.env.release.example` from the release assets into that folder.
4. Rename `.env.release.example` to `.env`. Release assets already contain the matching image version; for the first release this is `EFACTURA_VERSION=1.0.0` from tag `v1.0.0`.
5. Replace `POSTGRES_PASSWORD` and `APP_SESSION_SECRET` with two different random values. This command prints one suitable value; run it twice and copy each result to the appropriate setting:

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

## Start the application

From that folder, run:

```sh
docker compose --env-file .env -f compose.release.yaml pull
docker compose --env-file .env -f compose.release.yaml up -d database
docker compose --env-file .env -f compose.release.yaml --profile tools run --rm admin-bootstrap
docker compose --env-file .env -f compose.release.yaml up -d
```

Open <http://localhost:3100> and sign in as `admin` with the temporary password stored in `.local/admin/README.md`. You must change it on first login. The included Mailpit inbox is at <http://localhost:8025>.

The default installation uses simulated ANAF data and binds its ports to the current computer only. Add an ANAF connection and managed entity in the interface before synchronizing. Email delivery uses Mailpit until you configure a real SMTP provider.

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

Keep the same `.env`, database volume and `ANAF_TOKEN_ENCRYPTION_KEY` when upgrading. Review the release notes for migration or compatibility instructions.

## Stop or remove

Stop the application while retaining all data:

```sh
docker compose --env-file .env -f compose.release.yaml down
```

Do not add `-v` unless you intentionally want to permanently delete the PostgreSQL and simulator volumes.

## Live ANAF and HTTPS

Live ANAF requires private OAuth settings, a stable token-encryption key, an exact registered HTTPS callback and locally trusted certificates. Download `compose.https.yaml` from the same release and follow [the live connection guide](live-connection.md). Use `compose.release.yaml` in place of `compose.yaml` in its Docker commands, and omit `--build`.

This project has not undergone an independent security audit. Back up the database and encryption key, restrict access to the host and review the deployment for your environment before storing production invoice data.
