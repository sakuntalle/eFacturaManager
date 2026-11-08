# Roadmap

## 1. Clean up and refactor the e-invoice module

**Status: Ongoing.**

Refactor the initial e-invoice implementation into a foundation that can support larger features without making the app harder to maintain or extend.

- Clarify the boundaries between entity management, external integrations, database storage, background processing and the user interface.
- Simplify duplicated or tightly coupled code and establish shared components where they make sense.
- Preserve existing invoice collection, document storage and email notification behavior, with automated regression coverage as the code evolves.

## 2. Retrieve company fiscal messages from ANAF

**Status: Proof of concept in progress on [`feature/spv-messages`](https://github.com/sakuntalle/eFacturaManager/tree/feature/spv-messages).**

Add access to the company messages that ANAF (Romania's National Agency for Fiscal Administration) generates and stores for different fiscal events. These are separate from the e-Factura invoice messages already used by the app.

This integration requires a different authentication model from e-invoices. The initial proof of concept has shown that turning it into a reliable app feature involves more work than the first experiment suggested.

- Establish and validate a dedicated authentication and connection flow for this service.
- Retrieve and persist messages for each managed company, with a way to browse their contents and associated documents.
- Develop the proof of concept into a maintainable integration and validate the complete flow against ANAF.

## 3. Generate and manage outgoing invoices from PDF templates

**Status: Initial implementation in progress on [`feature/invoice_generation`](https://github.com/sakuntalle/eFacturaManager/tree/feature/invoice_generation).**

Create a module for business owners to issue and manage invoices for their own clients, alongside the existing received e-invoice inbox.

- Support PDF templates supplied with the app and templates uploaded by the user.
- Use each template's layout, background, styling and static text, filling the variable fields from the selected entity, client details and invoice inputs.
- Manage clients, invoice numbering, amounts and currencies per entity, and persist generated invoices and their PDFs for later access.

The first implementation focuses on a single supported PDF layout. Broader support for built-in and user-provided templates remains part of this roadmap.
