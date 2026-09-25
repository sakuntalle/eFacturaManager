import { AnafClient, request } from '../../src/anaf.ts';
import type { Config } from '../config.js';
import type { AnafGateway } from '../contracts.js';
import type { AnafConnection } from '../connection.js';

export class HttpAnafGateway implements AnafGateway {
    constructor(private cfg: Config, private connection: AnafConnection) {}
    private authorized<T>(work: (token: string) => Promise<T>) {
        return this.cfg.mode === 'mock' ? work('mock-only-access-token') : this.connection.withAccessToken(work);
    }
    private client(token: string) {
        const base = this.cfg.mode === 'mock' ? `${this.cfg.mockUrl}/${this.cfg.environment}/FCTEL/rest/` : undefined;
        return new AnafClient(this.cfg.environment, token, fetch, base);
    }
    async list(days: number) { return this.authorized(token => this.client(token).list(this.cfg.cif, days)); }
    async download(id: string) { return this.authorized(token => this.client(token).download(id)); }
    async pdf(xml: Uint8Array) {
        const standard = /<(?:[\w-]+:)?CreditNote[\s>]/.test(Buffer.from(xml).toString()) ? 'FCN' : 'FACT1';
        const base = this.cfg.mode === 'mock' ? `${this.cfg.mockUrl}/prod/FCTEL/rest/` : 'https://api.anaf.ro/prod/FCTEL/rest/';
        const bytes = await this.authorized(token => request(`${base}transformare/${standard}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
            body: Buffer.from(xml).toString('utf8'),
        }));
        if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new Error('ANAF conversion did not return a PDF.');
        return bytes;
    }
}
