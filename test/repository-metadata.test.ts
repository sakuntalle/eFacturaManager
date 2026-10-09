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
