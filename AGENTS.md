# Project instructions

- Use four spaces for code indentation.
- For every user-reported bug, add or extend an automated regression test that exercises the reported failure. Run the relevant tests with the fix. For browser-specific bugs, exercise the actual browser interaction rather than only calling an API with manually supplied headers.
- Never display or log ANAF client credentials, tokens, authorization codes, cookies, raw callback URLs, or raw provider error descriptions. Connection diagnostics must use fixed, allowlisted failure categories and validated HTTP status or database error codes only. The OAuth authorization redirect necessarily includes the client identifier; do not print that redirect URL.
