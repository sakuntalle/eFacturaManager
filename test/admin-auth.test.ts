import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_USERNAME, passwordHash, temporaryPassword, verifyPassword } from '../app/admin-auth.js';

test('initial administrator uses a unique 12-character password and salted hash', () => {
    assert.equal(ADMIN_USERNAME, 'admin');
    const first = temporaryPassword();
    const second = temporaryPassword();
    assert.match(first, /^[A-Za-z0-9_-]{12}$/);
    assert.notEqual(first, second);
    const hash = passwordHash(first);
    assert.notEqual(hash, passwordHash(first));
    assert.equal(verifyPassword(first, hash), true);
    assert.equal(verifyPassword(second, hash), false);
    assert.equal(verifyPassword(first, 'malformed'), false);
});
