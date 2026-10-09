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
