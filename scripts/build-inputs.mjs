import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep aligned with local COPY sources in Dockerfile; the regression test checks this.
export const BUILD_INPUTS = [
    '.dockerignore', 'Dockerfile', 'LICENSE', 'README.md',
    'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'app', 'src', 'web', 'scripts/build-inputs.mjs',
];

export async function buildFingerprint(root) {
    const rules = (await readFile(join(root, '.dockerignore'), 'utf8')).split(/\r?\n/)
        .filter(line => line && !line.startsWith('#')).map(line => {
            const value = line.trim();
            return { include: value.startsWith('!'), pattern: posix.normalize(value.replace(/^!/, '').replace(/^\/+|\/+$/g, '')) };
        }).filter(rule => rule.pattern !== '.');
    function ignored(path) {
        const parts = path.split('/');
        const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
        let excluded = false;
        for (const rule of rules) {
            if (ancestors.some(parent => posix.matchesGlob(parent, rule.pattern))) excluded = !rule.include;
        }
        return excluded;
    }
    const hash = createHash('sha256');
    async function visit(path) {
        if (ignored(path)) return;
        const target = join(root, path);
        const stat = await lstat(target);
        if (stat.isDirectory()) {
            hash.update(JSON.stringify([path, 'directory']));
            for (const child of (await readdir(target)).sort()) await visit(`${path}/${child}`);
        } else if (stat.isSymbolicLink()) {
            hash.update(JSON.stringify([path, 'symlink', await readlink(target)]));
        } else if (stat.isFile()) {
            const bytes = await readFile(target);
            hash.update(JSON.stringify([path, 'file', bytes.length]));
            hash.update(bytes);
        } else {
            throw new Error('Unsupported build input.');
        }
    }
    for (const path of [...BUILD_INPUTS].sort()) await visit(path);
    return hash.digest('hex');
}

export async function imageMatches(root, manifestPath) {
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
        throw error;
    }
    return manifest?.version === 1 && /^[a-f0-9]{64}$/.test(manifest.digest)
        && manifest.digest === await buildFingerprint(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [operation, root, manifestPath = '/app/build-inputs.json'] = process.argv.slice(2);
        if (!root || !['write', 'check'].includes(operation)) throw new Error('Invalid build input operation.');
        if (operation === 'write') {
            await writeFile(manifestPath, JSON.stringify({ version: 1, digest: await buildFingerprint(root) }));
        } else {
            process.exitCode = await imageMatches(root, manifestPath) ? 0 : 10;
        }
    } catch {
        console.error('Could not verify application build inputs.');
        process.exitCode = 1;
    }
}
