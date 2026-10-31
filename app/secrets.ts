import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AppSecrets = { sessionSecret: string; tokenEncryptionKey: string };

function validate(value: unknown): AppSecrets {
    const candidate = value as Partial<AppSecrets> | null;
    if (!candidate || typeof candidate.sessionSecret !== 'string' || candidate.sessionSecret.length < 32
        || typeof candidate.tokenEncryptionKey !== 'string'
        || Buffer.from(candidate.tokenEncryptionKey, 'base64').length !== 32
        || Buffer.from(candidate.tokenEncryptionKey, 'base64').toString('base64') !== candidate.tokenEncryptionKey) {
        throw new Error('Application secrets are invalid. Restore the private secrets backup.');
    }
    return { sessionSecret: candidate.sessionSecret, tokenEncryptionKey: candidate.tokenEncryptionKey };
}

export async function loadAppSecrets(directory: string, legacy: Partial<AppSecrets> = {}): Promise<AppSecrets> {
    const file = join(directory, 'secrets.json');
    const read = async () => {
        let value: unknown;
        try { value = JSON.parse(await readFile(file, 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
            throw new Error('Application secrets could not be read. Restore the private secrets backup.');
        }
        return validate(value);
    };
    try { return await read(); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const secrets = validate({
        sessionSecret: legacy.sessionSecret || randomBytes(32).toString('base64'),
        tokenEncryptionKey: legacy.tokenEncryptionKey || randomBytes(32).toString('base64'),
    });
    const temporary = join(directory, `.secrets-${randomBytes(12).toString('hex')}.tmp`);
    try {
        await writeFile(temporary, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
        try { await link(temporary, file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        // A hard link publishes a complete file atomically; concurrent processes use the winner.
        return await read();
    } finally {
        await rm(temporary, { force: true });
    }
}
