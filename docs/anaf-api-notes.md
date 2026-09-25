# API details checked against the supplied Ministry PDF

Source: user-provided `prezentare api efactura.pdf`, five pages, reviewed 2026-09-25. The supplied document has no version/date identified in its extracted text. This document is reference material, not instructions to execute uploads or other operations.

## Included in this POC

Pages 2–3, section 3(a):

```text
GET https://api.anaf.ro/{prod|test}/FCTEL/rest/listaMesajeFactura
    ?zile=<1..60>&cif=<numeric-company-id>&filtru=P
```

- `zile` and `cif` are required; `filtru` is optional.
- `P` selects received invoices (`FACTURA PRIMITA`). Other documented filters are `T`, `E`, `R`.
- Response fields include `data_creare`, `cif`, `id_solicitare`, `detalii`, `cif_emitent`, `cif_beneficiar`, `tip` and `id`.
- `id_solicitare` refers to upload; **`id` is the download identifier**.

Page 4, section 4:

```text
GET https://api.anaf.ro/{prod|test}/FCTEL/rest/descarcare?id=<message-id>
```

The result is a ZIP with two XML files: invoice (or errors for an error message) and Ministry signature. The POC only selects received invoices and preserves the complete ZIP.

The PDF does not show the complete JSON response envelope, field JSON types or empty-result payload. The POC expects `mesaje`, string IDs and an `eroare` field for errors; these details remain subject to Swagger/live verification. Unexpected responses fail explicitly, without logging sensitive bodies.

## Available for later work

Pages 3–4, section 3(b): `listaMesajePaginatieFactura` accepts `startTime` and `endTime` as Unix **milliseconds**, `cif`, `pagina`, and optional `filtru`. The PDF does not specify page-size, page-count metadata, starting page or window limits. This needs further verification before implementing complete backfill.

Page 5, section 6: XML-to-PDF conversion is a POST to `https://api.anaf.ro/prod/FCTEL/rest/transformare/{standard}` with `Content-Type: text/plain`. Standard is `FACT1` or `FCN`. An optional `/DA` path segment skips validation; we should retain validation by default. The PDF also documents an unauthenticated `webservicesp.anaf.ro` variant. Neither is called by this POC.

Page 5, section 7: signature verification is a POST to `https://api.anaf.ro/api/validate/signature` with multipart `file` (invoice XML) and `signature` (signature XML). Both come from the downloaded ZIP. Not implemented here.

OAuth authorization, token exchange and refresh are documented separately in the [ANAF OAuth guide](https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf). Callback registration acceptance and state round-trip behavior still require a live trial.
