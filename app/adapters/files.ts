import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { InvoiceFiles } from '../contracts.js';
import type { PostgresRepository } from './postgres.js';
import { digits } from '../../src/anaf.ts';

export class LocalInvoiceFiles implements InvoiceFiles {
    private root: string;
    constructor(cfg: Config) { this.root = join(cfg.dataDir, cfg.mode, cfg.environment, cfg.cif); }
    private path(id: string, kind: 'zip' | 'xml' | 'pdf') { return join(this.root, `${digits(id, 'Message ID')}.${kind}`); }
    async put(id: string, kind: 'zip' | 'xml' | 'pdf', data: Uint8Array) {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const temporary = join(this.root, `${randomUUID()}.part`);
        try {
            await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
            await rename(temporary, this.path(id, kind));
        } finally { await rm(temporary, { force: true }); }
    }
    async read(id: string, kind: 'zip' | 'xml' | 'pdf') { return readFile(this.path(id, kind)); }
}

export class PostgresInvoiceFiles implements InvoiceFiles {
    constructor(private repo: PostgresRepository) {}
    async put(id: string, kind: 'zip' | 'pdf', data: Uint8Array) {
        await this.repo.putFile(id, kind, data);
    }
    async read(id: string, kind: 'zip' | 'pdf') {
        return this.repo.readFile(id, kind);
    }
}
