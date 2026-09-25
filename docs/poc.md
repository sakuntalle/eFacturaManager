# ANAF invoice download POC

A small, read-only TypeScript CLI retained for validating the live ANAF connection alongside the application. It authorizes through your browser, lists received messages and saves a few original invoice ZIP archives. It does not upload invoices, send email, poll continuously, render PDFs or require a database.

## Run locally

Use **Node.js 24 or newer** on macOS, Linux or Windows. There are no npm dependencies or installation step; Node runs the erasable TypeScript directly. Native TypeScript execution does not perform static type checking.

```sh
npm run poc -- help
npm test
```

For this diagnostic tool, run Node directly on the computer whose browser can use your qualified certificate. The main application runs separately in Docker; keep it in mock mode while validating the live connection.

## 1. Register your own ANAF OAuth application

Your existing SPV certificate access is necessary, but is separate from application registration.

1. Follow ANAF's [application registration and OAuth guide](https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf), particularly the application profile section and JWT authorization steps.
2. Use the [ANAF developer registration portal](https://www.anaf.ro/InregOauth/) and register an application for **e-Factura**.
3. Register **`https://localhost:8765/callback`**. Enter exactly the same URL in `.env`, without the brackets displayed around ANAF's list of registered callbacks.
4. Obtain your application's client ID and client secret. Keep both in your local configuration; do not paste secrets or tokens into chat.

The user confirmed that ANAF's registration portal accepted **`https://localhost:8765/callback`**. The listener now requires HTTPS and a local certificate; HTTP callbacks are rejected. Completing authorization and verifying the live response still require a certificate-authorized trial.

The POC sends and verifies an OAuth `state` value. ANAF's Postman walkthrough leaves state empty; whether ANAF echoes it correctly still needs a live check. Do not remove state verification to work around a failure.

## 2. Configure locally

If `.env` does not yet exist, copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`). Otherwise edit the existing file without replacing your settings:

- `ANAF_ENV=prod` for real invoices from your SPV company. `test` addresses separate test data.
- `ANAF_CIF` is the company's tax identifier, optionally prefixed with `RO`.
- `ANAF_CLIENT_ID` and `ANAF_CLIENT_SECRET` are from **your own** registration.
- `ANAF_REDIRECT_URI` must exactly match the registered callback.
- `ANAF_TLS_CERT_FILE=.local/tls/localhost.pem` and `ANAF_TLS_KEY_FILE=.local/tls/localhost-key.pem` point to your local HTTPS certificate and private key.

Use dotenv double quotes around values if they contain special characters such as `#` or spaces. `.env`, token files and downloads are excluded by `.gitignore`.

### Local HTTPS certificate

Use [mkcert](https://github.com/FiloSottile/mkcert) to generate a development certificate trusted by the browser on this computer. On macOS:

```sh
brew install mkcert
mkcert -install
mkdir -p .local/tls
mkcert -cert-file .local/tls/localhost.pem -key-file .local/tls/localhost-key.pem localhost 127.0.0.1
chmod 600 .local/tls/localhost-key.pem
```

`mkcert -install` installs a development certificate authority into the local trust store and can prompt for administrator approval. Follow mkcert's platform-specific installation instructions on Linux or Windows; create `.local/tls` first, then use the same certificate-generation command. Firefox may also require `nss` and a browser restart.

This server certificate is separate from the qualified SPV certificate used to authenticate with ANAF. Keep its private key and mkcert's root CA private key local. The callback validates the certificate hostname and validity period before listening. Resolve certificate trust errors before starting authorization; do not disable TLS verification.

After generating the certificate, `npm run test:oauth` checks the local HTTPS callback on port 8765 using dummy credentials and intercepted token exchanges. It never contacts ANAF and does not save real tokens. The check explicitly trusts your mkcert CA for that test process; a pass does not replace installing browser trust with `mkcert -install`.

## 3. Connect with your certificate

```sh
npm run poc -- login
```

Open the printed HTTPS URL in your usual certificate-enabled browser on the same computer. The CLI redirects you to ANAF; select your qualified certificate and complete authorization. Your qualified certificate/private key is not uploaded to the CLI. The callback exchanges the short-lived code immediately and saves tokens locally. The listener binds only to `127.0.0.1` and exits after success or a five-minute wait. Use the printed `/connect/...` URL to start the flow; opening `/callback` directly cannot authorize the connection.

For this POC, tokens are **plaintext files** under `.local/<client-id-fingerprint>/tokens.json`, with owner-only file permissions on POSIX. Windows access depends on the containing directory's ACLs. Protect this folder and `.env`; this is not the credential-storage design for the final product. No client secret is distributed with the source.

If you already have an access token, optionally set `ANAF_ACCESS_TOKEN` in `.env` and skip login. It takes precedence over saved tokens; remove it before using the refresh command.

## 4. List and download

```sh
npm run poc -- list --days 7
npm run poc -- download --days 7 --limit 1
npm run poc -- download --days 30 --limit 3
npm run poc -- download --days 60 --id 1234567890
```

The final command's ID is an example: replace it with the **message/download ID** from `list`, not an invoice number or upload ID. Downloads must match a received invoice in the selected company's listing/window. The default is one invoice, with a POC maximum of ten per invocation; selection orders by the returned creation timestamp, newest first. Both selection paths download only `FACTURA PRIMITA` messages (including the accented spelling).

Files are stored as `downloads/prod/<CIF>/<message-id>.zip` (or `downloads/test/...`). Existing files are never overwritten. Each file is written to a temporary file, then published using a hard link so interrupted writes do not appear as completed downloads. Use a local filesystem with hard-link support (such as APFS, ext4 or NTFS); a crash may leave a `.part` file that can be removed later. ZIP bytes are preserved, with a basic ZIP signature check; archives are not extracted, CRC-validated or signature-verified. Open the ZIP with your system's archive utility to inspect its XML files. **This step produces the original archive, not a PDF.**

Successful downloads remain saved if another download fails. The command reports the failure and returns a nonzero exit status. Invoice metadata is intentionally printed by `list`; do not share its terminal output without checking for company information.

## Refresh and troubleshooting

```sh
npm run poc -- refresh
```

Refresh is explicit in this POC. It saves returned access/refresh tokens; run only one login/refresh command at a time. The official OAuth guide documents access tokens lasting 90 days and refresh tokens lasting 365 days; actual authorization can fail sooner due to changes in permissions or credentials.

- **401/403:** check token validity, application's e-Factura enrollment and certificate permissions for the selected CIF. Refresh or authorize again as appropriate.
- **No messages:** check production vs test, company and lookback period (1–60 days).
- **Port in use:** close the prior POC process or choose another port in both registration and `.env`.
- **Local callback fails:** verify the exact registered URI and that the browser can reach the listener. `127.0.0.1` is an alternative only if that exact callback is registered too.
- **State mismatch:** restart login. If reproducible, investigate ANAF callback behavior without sharing the callback URL, which contains the authorization code.
- **200 response with an error:** API application errors are treated as failures. Raw response bodies are deliberately not logged because they may include private data.
- **Already saved:** files are kept unchanged. To intentionally download again, first move the original elsewhere.

Requests have a 45-second timeout, reject redirects and cap each response at 50 MiB. There are no automatic retries in this POC. This is a deliberately bounded diagnostic tool, **not a complete archival sync**: it uses non-paginated listing, does not guarantee complete results for busy companies, and cannot recover history outside ANAF's ordinary availability window.

## Verification status and references

Automated tests use synthetic responses and temporary files. They check request targeting, received-invoice selection, HTTP/application failures, secret redaction, OAuth request construction and callback state checks, HTTPS configuration requirements, token replacement and original-file preservation. Registration acceptance was confirmed by the user; the tests do not prove successful ANAF authorization or that current live JSON response schemas match the fixtures. A real certificate-authorized list/download is still required.

Official references:

- [ANAF OAuth guide](https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf): retrieved during research.
- [ANAF service directory](https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/url_eFactura.html): retrieved; lists service names for the certificate-based host. This POC uses the OAuth host `api.anaf.ro`.
- [Ministry API reference](https://mfinante.gov.ro/static/10/eFactura/prezentare%20api%20efactura.pdf): initially unavailable through the research tool (HTTP 502). The user supplied the five-page PDF on 2026-09-25; it was read and checked against this POC. See [verified API notes](anaf-api-notes.md).
- [Message list Swagger](https://mfinante.gov.ro/static/10/eFactura/listamesaje.html) and [download Swagger](https://mfinante.gov.ro/static/10/eFactura/descarcare.html): also unavailable during research.

Confirmed against the supplied Ministry reference: the OAuth host, `listaMesajeFactura` parameters `cif`, `zile` (1–60), `filtru=P`, message field names and `FACTURA PRIMITA` type, and `descarcare?id=<message-id>` returning a ZIP with invoice and signature XML. The overview names response fields but does not specify a full JSON schema: envelope shape, empty-result errors and exact JSON value types still need confirmation from Swagger or a live response. Those details are isolated in `src/anaf.ts`.
