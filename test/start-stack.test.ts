import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

async function runHelper(args: string[], exitCode = '0') {
    const root = await mkdtemp(join(tmpdir(), 'efactura startup '));
    try {
        await Promise.all(['scripts', 'bin', '.local/tls'].map(path => mkdir(join(root, path), { recursive: true })));
        await copyFile(new URL('../scripts/start-stack.sh', import.meta.url), join(root, 'scripts/start-stack.sh'));
        await writeFile(join(root, 'bin/docker'),
            '#!/usr/bin/env bash\nexec "$START_STACK_TEST_NODE" -- "$START_STACK_TEST_STUB" "$@"\n', { mode: 0o755 });
        await Promise.all(['localhost.pem', 'localhost-key.pem'].map(name => writeFile(join(root, '.local/tls', name), 'synthetic-test-file')));
        const log = join(root, 'docker-calls.jsonl');
        const result = spawnSync('bash', [join(root, 'scripts/start-stack.sh'), ...args], {
            cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
            env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
                START_STACK_TEST_LOG: log, START_STACK_TEST_UP_CODE: exitCode,
                START_STACK_TEST_NODE: process.execPath,
                START_STACK_TEST_STUB: fileURLToPath(new URL('./helpers/start-stack-docker.mjs', import.meta.url)) },
        });
        const calls: string[][] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        return { ...result, calls };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('normal stack startup leaves missing-image builds to Compose without forcing rebuilds or recreation',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper([]);
        assert.equal(result.status, 0);
        const up = result.calls.find(args => args.includes('up'))!;
        assert.ok(up);
        for (const flag of ['--build', '--no-build', '--force-recreate', '--no-recreate']) assert.equal(up.includes(flag), false);
        assert.ok(up.includes('--wait'));
        assert.match(result.stdout, /Website ready: https:\/\/localhost:8765/);
        assert.equal(`${result.stdout}${result.stderr}`.includes('synthetic-private-configuration'), false);
    });

test('stack startup rebuilds only on request and preserves an environment filename containing spaces',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper(['--build', '--env-file', 'test settings.env']);
        assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.calls)}`);
        const up = result.calls.find(args => args.includes('up'))!;
        assert.ok(up.includes('--build'));
        assert.equal(up[up.indexOf('--env-file') + 1], 'test settings.env');
    });

test('explicit no-build disables even automatic builds and a startup failure is propagated',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper(['--no-build'], '7');
        assert.equal(result.status, 7);
        assert.ok(result.calls.find(args => args.includes('up'))!.includes('--no-build'));
        assert.equal(result.calls.some(args => args.includes('exec')), false);
        assert.doesNotMatch(result.stdout, /Website ready/);
    });
