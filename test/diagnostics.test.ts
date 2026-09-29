import test from 'node:test';
import assert from 'node:assert/strict';
import { AnafHttpError, AnafNetworkError } from '../src/anaf.js';
import { failureDetails, logFailure } from '../app/diagnostics.js';

test('failure diagnostics retain safe categories and never print provider or database error text', t => {
    const lines: string[] = [];
    t.mock.method(console, 'error', (line: string) => lines.push(line));
    const privateText = 'private-token-and-invoice-details';
    logFailure('worker', 'invoice_list', new AnafHttpError(503, privateText), {
        entityId: '00000000-0000-4000-8000-000000000001', days: 60,
    });
    logFailure('web', 'request', { code: '23503', message: privateText });
    logFailure('queue', 'publish', { code: 'ECONNREFUSED', message: privateText });
    logFailure('email', 'send', new Error(privateText));
    assert.equal(lines.length, 4);
    for (const line of lines) {
        assert.equal(line.includes(privateText), false);
        assert.equal(line.includes('00000000-0000-4000-8000-000000000001'), false);
        assert.equal(line.includes('message'), false);
    }
    assert.deepEqual(failureDetails(new AnafHttpError(503, privateText)), { category: 'anaf_http', httpStatus: 503 });
    assert.deepEqual(failureDetails(new AnafNetworkError('TIMEOUT')), { category: 'anaf_network', networkCode: 'TIMEOUT' });
    assert.deepEqual(failureDetails({ code: '23503', detail: privateText }), { category: 'database', databaseCode: '23503' });
    assert.deepEqual(failureDetails({ code: '23503\nprivate', message: privateText }), { category: 'unexpected' });
    assert.deepEqual(failureDetails({ code: 'EAUTH', message: privateText }), { category: 'unexpected' });
    assert.deepEqual(failureDetails(new Error(privateText)), { category: 'unexpected' });
});
