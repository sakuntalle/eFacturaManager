# In-app ANAF connection

The app login authenticates the local workspace administrator. Each ANAF connection is a separate certificate authorization that continues working after browser sign-out. Multiple companies or individuals can share a connection when that certificate has access to their fiscal identifiers.

## Local Docker HTTPS

These steps work with either a source checkout or a published release. For a Docker Desktop release installation, download `compose.https.yaml` with the other release assets, replace `compose.yaml` with `compose.release.yaml` in every command below, omit `--build`, and use the release bootstrap command from [docker-desktop.md](docker-desktop.md) instead of `npm run admin:bootstrap`.

1. Keep your deployment's registration in the private `.env`: `ANAF_CLIENT_ID`, `ANAF_CLIENT_SECRET`, and `ANAF_REDIRECT_URI=https://localhost:8765/callback`. These application credentials are shared by the installation; each connection stores its own encrypted certificate grant. Keep `ANAF_CIF` set to the original company that established the primary connection; it anchors its existing encrypted token. Do not commit, copy into the frontend, or print this file.
2. Set `APP_SESSION_SECRET` to at least 32 characters. Set `ANAF_TOKEN_ENCRYPTION_KEY` to a randomly generated 32-byte base64 value. Keep it stable across restarts and securely back it up. The web app and worker must share it. The administrator password is generated into PostgreSQL during bootstrap, not configured in `.env`. Quote configuration values that contain `#` so Node and Docker parse them consistently.
3. Create a locally trusted certificate covering `localhost` and `127.0.0.1` with mkcert. On macOS, `mkcert -install` may ask for your system password in Terminal. Certificate files belong at `.local/tls/localhost.pem` and `.local/tls/localhost-key.pem`. Keep the private key private. Windows and Linux also support mkcert; follow its platform-specific trust installation instructions.
4. Set `ANAF_MODE=live` and `APP_PUBLIC_URL=https://localhost:8765` in `.env`. From a source checkout, start with:

    ```sh
    docker compose --env-file .env -f compose.yaml -f compose.https.yaml up -d database
    npm run admin:bootstrap
    docker compose --env-file .env -f compose.yaml -f compose.https.yaml up --build -d
    ```

5. Open `https://localhost:8765`, sign in as `admin` with the temporary password in the Git-ignored `.local/admin/README.md`, and complete the mandatory password change. Open **Manage ANAF connections** and connect the primary authorization with your qualified certificate. To use another certificate authorization, add a named connection, link an entity to it, then choose Connect for that connection. The first linked entity supplies its access-check identifier. Each entity can be reassigned in its Settings page.

Do not run the diagnostic CLI listener at the same time: it uses the same callback port. HTTP port 3100 redirects to the HTTPS application when the HTTPS override is enabled. Health checks remain available internally over HTTP.

On Linux, the web container runs as UID 1000; ensure it can read the mounted TLS files without making the private key publicly readable. For other hosting environments, terminate HTTPS at a reverse proxy and set the public URL and registered callback to your own exact HTTPS origin. Native Node hosting supports `APP_TLS_CERT_FILE`, `APP_TLS_KEY_FILE`, and `APP_TLS_PORT`.

## Authorization and recovery

- Connect requires an authenticated app session and a same-origin POST. The return uses one-time random state plus a Secure, HttpOnly, SameSite=Lax browser binding cookie, valid for five minutes. The main login cookie remains SameSite=Strict. A revoked or expired initiating session invalidates the return.
- The backend exchanges the code and verifies invoice-list access for the connection's verification identifier: `ANAF_CIF` for the primary connection, or the first linked entity for a new one. ANAF independently checks access to every linked identifier during collection. Tokens never enter frontend storage or API responses. Raw OAuth responses and callback queries are not logged. Configure any external proxy to omit callback query strings, authorization headers, cookies and response Location headers from access logs or tracing.
- Refresh happens before authenticated ANAF requests when expiry is near, and once after an authorization rejection. Database locking prevents concurrent refresh rotation. Temporary failures retry; terminal refresh failures require reconnecting. JWT expiry is used only as a scheduling hint, never for local user authentication.
- Disconnect deletes only that connection's local tokens and pending authorization attempt. Collection pauses for its linked entities; other connections keep working. Stored invoices, PDFs and email activity remain available. Local disconnect does not revoke the grant at ANAF. Existing email jobs can still deliver notifications for already collected invoices.
- Changing the app registration, encryption key or API environment requires reconnecting. Keep the original `ANAF_CIF` stable for the primary connection; changing its verification identifier would also require reconnecting. Changing an entity’s notification address or polling interval does not. Mock/live invoice data remain isolated. Use the same deployment encryption key for all processes in the workspace.

## Verification

`npm test` covers callback binding, expiry/replay, logout, company access, encryption, refresh rotation, temporary/terminal failures and disconnect. `npm run test:entities` verifies migration of the existing encrypted grant and isolation of connection records in temporary PostgreSQL data. `npm run test:connection` builds and runs a separate HTTPS test app on ports 9876/9877/3199 against a temporary isolated PostgreSQL database, using synthetic credentials, a local HTTPS authorization provider, and intercepted ANAF API responses. It includes a second independently authorized connection, browser connect/disconnect/reconnect, immediate authorization denial, and retry. Chrome is required. It requires the local mkcert files and running development database. `npm run test:browser` includes connection management and mock-mode regressions.

Real qualified-certificate authorization still needs a browser round trip with ANAF. The app deliberately refuses an absent or mismatched OAuth state; do not disable this check to work around an unexpected ANAF response.
