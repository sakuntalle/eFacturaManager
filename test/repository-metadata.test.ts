import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('CI badge reports main push status instead of pull request results', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.match(readme, /ci\.yml\/badge\.svg\?branch=main&event=push/);
});
