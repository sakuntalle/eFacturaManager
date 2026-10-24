# Local HTTPS setup

Both Docker Compose entry points require HTTPS certificates before their first web launch. The source stack starts with `docker compose up -d --build`; the release stack starts with `docker compose -f compose.release.yaml up -d`. The default address is `https://localhost:8765`.

## Create and trust the certificates

Install mkcert using its installation instructions for your operating system. Run these commands from your source checkout or release installation folder. `mkcert -install` installs a local certificate authority into your trust store and may request administrator approval. Run it once on each host.

On macOS or Linux:

```sh
mkdir -p .local/tls
mkcert -install
mkcert -cert-file .local/tls/localhost.pem -key-file .local/tls/localhost-key.pem localhost 127.0.0.1 ::1
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force .local/tls
mkcert -install
mkcert -cert-file .local/tls/localhost.pem -key-file .local/tls/localhost-key.pem localhost 127.0.0.1 ::1
```

Docker mounts `.local/tls` read-only and selects those two filenames automatically. Keep the private key private. On Linux the web container runs as UID 1000; ensure that user can read the files without making the key publicly readable. Restart the browser if it was open while the certificate authority was installed.

## Upgrade an existing HTTP installation

Update your private `.env` before starting the updated stack:

```dotenv
APP_PUBLIC_URL=https://localhost:8765
APP_TLS_PORT=8765
```

An existing `APP_PUBLIC_URL=http://localhost:3100` overrides the new default. Docker processes now reject it at startup with the fixed diagnostic `https_public_url_required`. Set both the URL and port, and create the certificate files before restarting. A port mismatch produces `tls_port_mismatch`; invalid ports produce `tls_port_invalid`. For a different local TLS port, change both settings to match. When using real ANAF OAuth, the callback URL must match the registered HTTPS origin and port exactly.

Each Compose file defines the default TLS port once and reuses it for the listener and published port. When `APP_PUBLIC_URL` is unset or empty, the app derives `https://localhost:<APP_TLS_PORT>`. When `ANAF_REDIRECT_URI` is unset or empty, it derives `<APP_PUBLIC_URL>/callback`. Explicit values in your `.env` override these derived URLs.

Start the source stack with `docker compose up -d --build --wait`, or the release stack with `docker compose -f compose.release.yaml up -d --wait`. Open `APP_PUBLIC_URL`. Existing database volumes are preserved. Docker publishes only the TLS listener; the internal HTTP health-check listener is not accessible on host port 3100.

Native Vite development can still use `APP_PUBLIC_URL=http://localhost:5173` without TLS certificate settings. Switch it back to the HTTPS origin before starting the Docker application. `APP_REQUIRE_HTTPS=true` is set internally by Compose for the web app and worker.

## Trust HTTPS in the local integration test

`npm run test:integration` targets `https://localhost:8765` by default. `TEST_APP_URL` can select a different local HTTPS origin. HTTP and remote targets are rejected. The test changes data and exercises email delivery: run it only against a separate simulator workspace with Mailpit and set `TEST_ADMIN_PASSWORD` to that test workspace's administrator password.

Node must trust the same mkcert certificate authority as your browser. Set `NODE_EXTRA_CA_CERTS` before starting Node; TLS verification remains enabled.

On macOS or Linux:

```sh
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
npm run test:integration
```

On Windows PowerShell:

```powershell
$env:NODE_EXTRA_CA_CERTS = Join-Path (mkcert -CAROOT) 'rootCA.pem'
npm run test:integration
```

Set `TEST_APP_URL=https://localhost:<port>` in the environment when using a custom port. Missing or untrusted certificates must fail verification; do not disable TLS verification to run this test.
