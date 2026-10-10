import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('CI badge reports main push status instead of pull request results', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.match(readme, /ci\.yml\/badge\.svg\?branch=main&event=push/);
});

test('live ANAF documentation keeps the HTTPS Compose override and exact callback guidance', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const development = readFileSync(new URL('../docs/development.md', import.meta.url), 'utf8');
    const liveConnection = readFileSync(new URL('../docs/live-connection.md', import.meta.url), 'utf8');
    const sourceCommand = 'docker compose --env-file .env -f compose.yaml -f compose.https.yaml up -d --build';

    assert.ok(readme.includes(sourceCommand));
    assert.ok(development.includes(sourceCommand));
    assert.ok(liveConnection.includes(sourceCommand));
    for (const documentation of [readme, development, liveConnection]) {
        assert.ok(documentation.includes('https://localhost:8765/callback'));
        assert.match(documentation, /exact (registered )?(OAuth )?callback/i);
    }
});

test('GitHub workflows pin the Ubuntu runner image', () => {
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

    for (const workflow of [ci, release]) {
        assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
        assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
    }

    const configuredNodeSteps = ci.match(/- uses: actions\/checkout@v7\s+- uses: actions\/setup-node@v6\s+with:\s+node-version: 24\s+cache: npm/g);
    assert.equal(configuredNodeSteps?.length, 2);
});

test('release publishes the environment template with a downloadable filename', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const dockerGuide = readFileSync(new URL('../docs/docker-desktop.md', import.meta.url), 'utf8');

    assert.match(workflow, /cp \.env\.release\.example env\.release\.example/);
    assert.match(workflow, /^\s+env\.release\.example$/m);
    assert.doesNotMatch(workflow, /^\s+\.env\.release\.example$/m);
    assert.ok(readme.includes('`env.release.example`'));
    assert.ok(dockerGuide.includes('Rename `env.release.example` to `.env`'));
});

test('release requires curated versioned notes and preserves GitHub generated notes', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const releaseGuide = readFileSync(new URL('../docs/releases/README.md', import.meta.url), 'utf8');
    const currentNotes = readFileSync(new URL('../docs/releases/v1.0.1.md', import.meta.url), 'utf8');

    assert.ok(workflow.includes('notes_file="docs/releases/v$REQUESTED_VERSION.md"'));
    assert.ok(workflow.includes('if [[ ! -s "$notes_file" ]]'));
    assert.ok(workflow.includes('RELEASE_NOTES_FILE: ${{ steps.version.outputs.notes_file }}'));
    assert.match(workflow, /--generate-notes\s+\\\s+--notes "\$\(cat "\$RELEASE_NOTES_FILE"\)"/);
    assert.ok(releaseGuide.includes('npm version X.Y.Z --no-git-tag-version'));
    assert.match(currentNotes, /^## Highlights/m);
    assert.match(currentNotes, /^## Upgrade notes/m);
});

test('README documents the supported release platforms and non-developer installation', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

    assert.match(readme, /## Install a release \(non-developers\)/);
    assert.ok(readme.includes('`linux/amd64`'));
    assert.ok(readme.includes('`linux/arm64`'));
    assert.ok(readme.includes('Native Windows containers'));
    assert.ok(readme.includes('docker compose --env-file .env -f compose.release.yaml pull'));
    assert.ok(readme.includes('--profile tools run --rm admin-bootstrap'));
    assert.ok(readme.includes('docker compose down -v` permanently deletes'));
    assert.ok(readme.includes('-f compose.release.yaml -f compose.https.yaml up -d'));
});
