# Maintainer release process

Only the GitHub account `sakuntalle` may publish a release. The release workflow is manual, runs only from `main`, and rejects any version that does not exactly match the version in `package.json`.

## Repository access and branch protection

Keep `sakuntalle` as the only repository administrator. Contributors who do not need repository write access should work from forks. Do not grant another account Admin or Maintain access if that account must not be able to bypass repository rules or manage releases.

After the repository has been published, create an active branch ruleset in **Settings → Rules → Rulesets → New ruleset → New branch ruleset** with `main` as its target. Add **Repository administrators** to the bypass list with **For pull requests only**, and do not add any other bypass actor. Enable these rules:

- Restrict deletions and force pushes.
- Require a pull request before merging.
- Require at least one approval.
- Require review from Code Owners.
- Dismiss stale approvals when new commits are pushed.
- Require approval of the most recent reviewable push.
- Require all conversations to be resolved before merging.
- Require the `test` and `e2e` status checks from the **CI** workflow to pass.

The repository's [CODEOWNERS file](../.github/CODEOWNERS) assigns every path to `@sakuntalle`, so the required Code Owner review ensures that no contributor can merge into `main` without Mihnea's approval.

GitHub does not allow a pull request author to approve their own pull request. Because `sakuntalle` is the only administrator, the PR-only administrator bypass lets Mihnea merge a maintainer-authored pull request without allowing a direct push to `main`. A contributor's pull request still requires Mihnea's Code Owner approval. If maintainer-authored changes must also receive an independent approval, remove the bypass and add a second trusted code owner instead.

CODEOWNERS declares ownership but does not enforce approval on its own. The active GitHub ruleset is the enforcement mechanism.

## Restrict release execution

By default, any collaborator with write access can manually request a GitHub Actions workflow. Add a second server-side safeguard in **Settings → Actions → Policies**:

1. Create an active policy targeting `.github/workflows/release.yml` in this repository.
2. Restrict actors to the GitHub user `sakuntalle`.
3. Restrict the allowed event to `workflow_dispatch`.

This policy prevents other accounts from starting the release workflow at all. The workflow also checks the actor and branch itself, so a run can publish only when `sakuntalle` requests it from `main`.

## Publish a release

1. Merge a pull request that sets the intended stable version in `package.json` and `package-lock.json`.
2. Confirm the **CI** workflow passes on `main`.
3. Open **Actions → Publish release → Run workflow**.
4. Select the `main` branch and enter the version without a leading `v`, for example `1.0.0`.
5. Run the workflow while signed in as `sakuntalle`.

The workflow builds and publishes the multi-platform GHCR image, updates the `latest`, major, minor and exact-version image tags, creates the matching Git tag and GitHub Release, and attaches the Docker Desktop deployment files.

Runs requested by another account or from a branch other than `main` are skipped and cannot publish an image or release. Pushing a Git tag does not trigger publishing.

For the first release, make the `ghcr.io/sakuntalle/efactura-manager` package public in its GHCR package settings after the workflow finishes. Later releases retain that package visibility.
