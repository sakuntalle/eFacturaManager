import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgresRepository } from './adapters/postgres.js';
import { ADMIN_USERNAME, passwordHash, temporaryPassword } from './admin-auth.js';
import { config } from './config.js';

const repo = new PostgresRepository(config());
try {
    await repo.initialize();
    if (await repo.adminAccount()) {
        console.log('Administrator account already exists. No password was generated.');
    } else {
        const password = temporaryPassword();
        const directory = process.env.ADMIN_BOOTSTRAP_DIR ?? '.local/admin';
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = join(directory, 'README.md');
        const temporary = join(directory, `README.${process.pid}.tmp`);
        await writeFile(temporary, `# Initial administrator login\n\nUsername: ${ADMIN_USERNAME}\n\nTemporary password: ${password}\n\nOpen the app and change this password when prompted. This file is local and ignored by Git.\n`,
            { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
        if (!await repo.createAdmin(passwordHash(password))) {
            throw new Error('Administrator account was created by another process.');
        }
        console.log('Administrator account created. Read the initial password in the local administrator README.');
    }
} finally {
    await repo.close();
}
