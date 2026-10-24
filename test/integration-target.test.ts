import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationOrigin } from '../scripts/integration-target.mjs';

test('Docker integration targets the HTTPS listener by default and accepts custom local HTTPS origins', () => {
    assert.equal(integrationOrigin({}), 'https://localhost:8765');
    assert.equal(integrationOrigin({ TEST_APP_URL: 'https://127.0.0.1:9876/' }), 'https://127.0.0.1:9876');
    assert.equal(integrationOrigin({ TEST_APP_URL: 'https://[::1]:9876' }), 'https://[::1]:9876');
});

test('Docker integration rejects HTTP and remote targets before sending credentials or changing data', () => {
    for (const url of ['http://localhost:3100', 'https://remote.example', 'https://user:pass@localhost:8765',
        'https://localhost:8765/path', 'https://localhost:8765/?query=1', 'https://localhost:8765/#fragment',
        'https://localhost:0']) {
        assert.throws(() => integrationOrigin({ TEST_APP_URL: url }), /local HTTPS origin/);
    }
});
