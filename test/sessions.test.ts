import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../app/config.js';
import { Sessions, SESSION_COOKIE, SESSION_DURATION, REMEMBER_DURATION, sessionToken } from '../app/sessions.js';
import type { SessionStore } from '../app/contracts.js';

function harness() {
    const records = new Map<string, Date>();
    const store: SessionStore = {
        saveSession: async (hash, expiresAt) => { records.set(hash, expiresAt); },
        hasSession: async hash => (records.get(hash)?.getTime() ?? 0) > Date.now(),
        deleteSession: async hash => { records.delete(hash); },
    };
    return { records, store, sessions: new Sessions(store, config({})) };
}

test('unchecked login uses a session cookie and expires on the server after eight hours', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
    const { sessions, records } = harness();
    const { token, cookie } = await sessions.create(false);
    assert.equal('maxAge' in cookie, false);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'strict');
    assert.equal(records.has(token), false, 'Only a hash is stored');
    assert.equal(await sessions.valid(`${SESSION_COOKIE}=${token}`), true);
    t.mock.timers.tick(SESSION_DURATION);
    assert.equal(await sessions.valid(`${SESSION_COOKIE}=${token}`), false);
});

test('remembered sessions persist for 30 days and support restart, expiry and logout', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
    const { sessions, store } = harness();
    const { token, cookie } = await sessions.create(true);
    const header = `${SESSION_COOKIE}=${token}`;
    assert.equal(cookie.maxAge, REMEMBER_DURATION);
    const restarted = new Sessions(store, config({}));
    assert.equal(await restarted.valid(header), true);
    t.mock.timers.tick(REMEMBER_DURATION - 1);
    assert.equal(await restarted.valid(header), true);
    t.mock.timers.tick(1);
    assert.equal(await restarted.valid(header), false);
    const next = await restarted.create(true);
    assert.notEqual(next.token, token);
    await restarted.revoke(`${SESSION_COOKIE}=${next.token}`);
    assert.equal(await restarted.valid(`${SESSION_COOKIE}=${next.token}`), false);
});

test('credential changes, forged tokens and malformed cookies cannot reuse a session', async () => {
    const { sessions, store } = harness();
    const { token } = await sessions.create(true);
    const header = `${SESSION_COOKIE}=${token}`;
    for (const overrides of [{ APP_ADMIN_PASSWORD: 'changed-password' }, { APP_ADMIN_EMAIL: 'other@example.test' }, { APP_SESSION_SECRET: 'x'.repeat(32) }]) {
        assert.equal(await new Sessions(store, config(overrides)).valid(header), false);
    }
    assert.equal(await sessions.valid(`${SESSION_COOKIE}=${'0'.repeat(64)}`), false);
    assert.equal(await sessions.valid(), false);
    assert.equal(sessionToken('efactura_session=malformed'), undefined);
    assert.equal(sessionToken(`other=one; ${header}; another=two`), token);
    assert.equal(new Sessions(store, { ...config({}), publicUrl: 'https://example.test' }).cookieOptions().secure, true);
});
