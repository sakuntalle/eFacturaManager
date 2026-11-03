import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INPUTS, buildFingerprint, imageMatches } from '../scripts/build-inputs.mjs';

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
    const root = await mkdtemp(join(tmpdir(), 'efactura build inputs '));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const input of BUILD_INPUTS) {
        const path = join(root, ['app', 'src', 'web'].includes(input) ? `${input}/index.ts` : input);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, input === '.dockerignore' ? '.env\n.local\nnode_modules\nweb/*.log\n' : `synthetic ${input}`);
    }
    return root;
}

test('image detection catches uncommitted edits, new files, renames, deletions and branch switches without using timestamps', async t => {
    const root = await fixture(t);
    const original = await buildFingerprint(root);
    const source = join(root, 'web/index.ts');
    const contents = await readFile(source);
    await utimes(source, new Date(0), new Date(0));
    assert.equal(await buildFingerprint(root), original, 'Touching unchanged source does not require a rebuild');
    await writeFile(source, Buffer.alloc(contents.length, 65));
    await utimes(source, new Date(0), new Date(0));
    assert.notEqual(await buildFingerprint(root), original, 'Same-size edits with the same timestamp still need a rebuild');
    await writeFile(source, contents);
    assert.equal(await buildFingerprint(root), original, 'Switching back to identical sources reuses the image');
    await writeFile(join(root, 'web/new.ts'), 'untracked source');
    assert.notEqual(await buildFingerprint(root), original);
    await rm(join(root, 'web/new.ts'));
    await rename(source, join(root, 'web/renamed.ts'));
    assert.notEqual(await buildFingerprint(root), original);
    await rm(join(root, 'web/renamed.ts'));
    assert.notEqual(await buildFingerprint(root), original);
});

test('runtime settings, local data and Docker-ignored files do not invalidate the image, while lockfile and Dockerfile edits do', async t => {
    const root = await fixture(t);
    const original = await buildFingerprint(root);
    for (const path of ['.env', '.local/test-data', 'node_modules/test.js', 'web/debug.log', 'test/new.test.ts']) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), 'synthetic runtime data');
    }
    assert.equal(await buildFingerprint(root), original);
    for (const path of ['package-lock.json', 'Dockerfile', '.dockerignore', 'scripts/build-inputs.mjs']) {
        const contents = await readFile(join(root, path));
        await writeFile(join(root, path), Buffer.concat([contents, Buffer.from('\nchanged')]));
        assert.notEqual(await buildFingerprint(root), original, path);
        await writeFile(join(root, path), contents);
    }
});

test('fingerprints belong to the image and missing, invalid or outdated metadata requires rebuilding', async t => {
    const root = await fixture(t);
    const manifest = join(root, 'build-inputs.json');
    const script = fileURLToPath(new URL('../scripts/build-inputs.mjs', import.meta.url));
    assert.equal(await imageMatches(root, manifest), false);
    for (const contents of ['invalid JSON', 'null', JSON.stringify({ version: 2, digest: 'old' })]) {
        await writeFile(manifest, contents);
        assert.equal(await imageMatches(root, manifest), false);
    }
    const written = spawnSync(process.execPath, [script, 'write', root, manifest], { encoding: 'utf8' });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(await imageMatches(root, manifest), true);
    assert.equal(spawnSync(process.execPath, [script, 'check', root, manifest]).status, 0);
    await writeFile(join(root, 'web/index.ts'), 'different branch source');
    assert.equal(spawnSync(process.execPath, [script, 'check', root, manifest]).status, 10);
    await rm(join(root, 'web'), { recursive: true });
    const failed = spawnSync(process.execPath, [script, 'check', root, manifest], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr.trim(), 'Could not verify application build inputs.');
    assert.equal(failed.stdout, '');
});

test('fingerprint covers every local Dockerfile COPY input', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const sources = dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.includes('--from='))
        .flatMap(line => line.split(/\s+/).slice(1, -1));
    assert.deepEqual([...new Set(sources)].sort(), [...BUILD_INPUTS].sort());
    assert.match(dockerfile, /RUN node scripts\/build-inputs\.mjs write \/app && npm run build/);
    assert.match(dockerfile, /COPY --from=build \/app\/build-inputs\.json \.\/build-inputs\.json/);
});
