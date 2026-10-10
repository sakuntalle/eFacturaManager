# Release notes

Every published version must include curated release notes. GitHub prepends this file to its automatically generated pull-request and contributor changelog.

For a new `X.Y.Z` release:

1. Update the package version without creating a local tag:

    ```sh
    npm version X.Y.Z --no-git-tag-version
    ```

2. Add `docs/releases/vX.Y.Z.md` with at least `Highlights` and `Upgrade notes` sections. Describe user-visible behavior, compatibility changes, migrations and any manual actions. Do not include credentials, tokens, raw callback URLs, provider errors or other private data.
3. Run the complete validation suite and rebuild the Docker image.
4. Commit and push the version, release notes and related changes to `main`, then wait for CI to pass.
5. As repository owner, manually run the **Publish release** workflow from `main` with `X.Y.Z` as the version. The workflow rejects missing or empty release notes and versions that do not match `package.json`.

The workflow publishes the curated notes, GitHub's generated changelog, multi-platform container tags and the Docker Desktop installation files in one release.
