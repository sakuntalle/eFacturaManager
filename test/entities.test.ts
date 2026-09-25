import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityInput } from '../app/entity-input.js';

const base = { name: 'Test Company', kind: 'company', cif: 'RO12345678', emailTo: 'invoices@example.org',
    emailEnabled: true, pollSeconds: 60 };

test('company and individual forms normalize only company prefixes and require a 13-digit CNP', () => {
    assert.deepEqual(entityInput(base), { ...base, cif: '12345678' });
    const person = entityInput({ ...base, name: 'Test Person', kind: 'individual', cif: '1234567890123' });
    assert.equal(person.kind, 'individual');
    assert.equal(person.cif, '1234567890123');
    for (const cif of ['RO1234567890123', '123', '123456789012A']) {
        assert.throws(() => entityInput({ ...base, kind: 'individual', cif }), /CNP/);
    }
});

test('entity settings reject invalid notification addresses and polling intervals', () => {
    for (const emailTo of ['', 'not-an-email', 'recipient@example.org\nBcc: other@example.org']) {
        assert.throws(() => entityInput({ ...base, emailTo }), /email/);
    }
    for (const pollSeconds of [14, 86401, 10.5]) {
        assert.throws(() => entityInput({ ...base, pollSeconds }), /Polling/);
    }
});
