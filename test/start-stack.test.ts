import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

async function runHelper(args: string[], exitCode = '0', imagePresent = true, checkCode = '0') {
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
                START_STACK_TEST_IMAGE_PRESENT: String(imagePresent), START_STACK_TEST_CHECK_CODE: checkCode,
                START_STACK_TEST_NODE: process.execPath,
                START_STACK_TEST_STUB: fileURLToPath(new URL('./helpers/start-stack-docker.mjs', import.meta.url)) },
        });
        const calls: string[][] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        return { ...result, calls };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('normal stack startup reuses a matching image without building or forcing recreation',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper([]);
        assert.equal(result.status, 0);
        const up = result.calls.find(args => args.includes('up'))!;
        assert.ok(up);
        assert.ok(up.includes('--no-build'));
        for (const flag of ['--build', '--force-recreate', '--no-recreate']) assert.equal(up.includes(flag), false);
        const check = result.calls.find(args => args[0] === 'run')!;
        assert.ok(check.includes('/workspace/scripts/build-inputs.mjs'));
        assert.ok(check.includes('check'));
        assert.equal(check[check.indexOf('--network') + 1], 'none');
        assert.match(check[check.indexOf('--mount') + 1], /target=\/workspace,readonly$/);
        assert.ok(up.includes('--wait'));
        assert.match(result.stdout, /Website ready: https:\/\/localhost:8765/);
        assert.equal(`${result.stdout}${result.stderr}`.includes('synthetic-private-configuration'), false);
    });

test('explicit rebuild skips detection and preserves an environment filename containing spaces',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper(['--build', '--env-file', 'test settings.env']);
        assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.calls)}`);
        const up = result.calls.find(args => args.includes('up'))!;
        assert.ok(up.includes('--build'));
        assert.equal(result.calls.some(args => args[0] === 'run' || args[0] === 'image'), false);
        assert.equal(up[up.indexOf('--env-file') + 1], 'test settings.env');
    });

test('normal startup builds missing images and rebuilds changed sources or older images without a fingerprint',
    { skip: process.platform === 'win32' }, async () => {
        for (const imagePresent of [false, true]) {
            const result = await runHelper([], '0', imagePresent, '10');
            assert.equal(result.status, 0);
            const up = result.calls.find(args => args.includes('up'))!;
            assert.ok(up.includes('--build'));
            assert.equal(up.includes('--no-build'), false);
            assert.equal(result.calls.some(args => args[0] === 'run'), imagePresent);
            assert.match(result.stdout, /building/);
        }
    });

test('a failed source check stops startup instead of running an unverified image',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper([], '0', true, '1');
        assert.equal(result.status, 1);
        assert.equal(result.calls.some(args => args.includes('up') || args.includes('exec')), false);
        assert.match(result.stderr, /Could not check the application image/);
    });

test('explicit no-build disables even automatic builds and a startup failure is propagated',
    { skip: process.platform === 'win32' }, async () => {
        const result = await runHelper(['--no-build'], '7');
        assert.equal(result.status, 7);
        assert.ok(result.calls.find(args => args.includes('up'))!.includes('--no-build'));
        assert.equal(result.calls.some(args => args[0] === 'run' || args[0] === 'image'), false);
        assert.equal(result.calls.some(args => args.includes('exec')), false);
        assert.doesNotMatch(result.stdout, /Website ready/);
    });

test('unhealthy startup explains image rebuilding while preserving the Docker failure code',
    { skip: process.platform === 'win32' }, async () => {
        for (const args of [[], ['--build']]) {
            const result = await runHelper(args, '7');
            assert.equal(result.status, 7);
            assert.match(result.stderr, /stack did not become healthy/);
            assert.equal(result.stderr.includes('rerun this helper with --build'), args.length === 0);
            assert.equal(result.calls.some(call => call.includes('exec')), false);
            assert.doesNotMatch(result.stdout, /Website ready/);
            assert.equal(`${result.stdout}${result.stderr}`.includes('synthetic-private-configuration'), false);
        }
    });
