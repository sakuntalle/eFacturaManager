# Contributing to eFactura Manager

Thank you for considering a contribution. Bug reports, documentation improvements and focused pull requests are welcome.

## Before opening an issue

- Search existing issues and discussions first.
- Do not include ANAF credentials, OAuth values, cookies, callback URLs containing query parameters, fiscal invoice documents, SMTP credentials or administrator passwords.
- For a bug, include the affected release, operating system, browser, reproduction steps and the expected result. Sanitize logs before attaching them.
- Use GitHub's private vulnerability reporting instead of a public issue for security problems; see [SECURITY.md](SECURITY.md).

## Development setup

Follow [docs/development.md](docs/development.md). Work from a branch based on `main` and keep changes focused. The codebase uses four spaces for indentation.

When changing behavior:

- Add or update an automated regression test for every bug fix.
- Use a real browser interaction test for browser-specific behavior.
- Preserve the rule that credentials, tokens, cookies, raw OAuth callbacks and raw provider errors are never displayed or logged.
- Update user-facing and operational documentation when configuration or deployment behavior changes.

Run the relevant checks before opening a pull request:

```sh
npm run typecheck
npm test
npm run build
```

For user-interface changes, also run the affected Playwright tests. The full local test commands are documented in [docs/development.md](docs/development.md).

Every pull request runs both the unit/build check and the complete Playwright browser suite in CI. Both checks must pass before merging.

## Pull requests

All changes to `main` must go through a pull request. Describe what changed, why it changed and how it was verified. Link the relevant issue when one exists. Keep unrelated formatting or refactoring out of the pull request. Reviewers may ask for tests, migration notes, screenshots or documentation updates proportional to the change.

The repository owner, `@sakuntalle`, is the Code Owner for the entire project. A pull request must pass CI and receive that Code Owner's approval before it can be merged. Contributors must not merge their own pull requests or push directly to `main`.

By submitting a contribution, you agree that it is licensed under the project's [GPL-3.0-or-later license](LICENSE) and that you have the right to submit it under those terms.
