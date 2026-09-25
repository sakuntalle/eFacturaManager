import { mkdir, readFile, rename, writeFile, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record, digits } from './anaf.ts';
import type { Tokens, Environment } from './anaf.ts';

export async function readTokens(path: string): Promise<Tokens> {
    let data: unknown;
    try { data = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error('No readable token file. Run login or set ANAF_ACCESS_TOKEN in .env.'); }
    if (!record(data) || typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('Invalid token file. Authorize again.');
    }
    return {
        access_token: data.access_token,
        ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
        obtained_at: typeof data.obtained_at === 'string' ? data.obtained_at : '',
    };
}

export async function saveTokens(directory: string, tokens: Tokens): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `tokens-${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, JSON.stringify(tokens, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(directory, 'tokens.json'));
    } finally { await rm(temporary, { force: true }); }
}

export async function saveArchive(
    root: string, environment: Environment, cif: string, id: string, bytes: Uint8Array,
): Promise<string> {
    if (environment !== 'prod' && environment !== 'test') throw new Error('Invalid environment.');
    const directory = join(root, environment, digits(cif, 'CIF'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${digits(id, 'Message ID')}.zip`);
    const temporary = join(directory, `.${id}-${randomUUID()}.part`);
    try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        // Publish a fully written file atomically without replacing an existing original.
        // A process crash during writing can leave a .part file, never a partial final ZIP.
        await link(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return path;
}
