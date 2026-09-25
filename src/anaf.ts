export type Environment = 'prod' | 'test';
export type Fetch = typeof globalThis.fetch;
export type Message = {
    id: string;
    tip: string;
    data_creare: string;
    detalii: string;
};
export type Tokens = {
    access_token: string;
    refresh_token?: string;
    obtained_at: string;
    expires_in?: number;
};

export class AnafHttpError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

const TOKEN_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/token';
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function digits(value: string, name: string): string {
    if (!/^\d{1,30}$/.test(value)) throw new Error(`${name} must contain only digits (1–30).`);
    return value;
}

export function integer(value: string, name: string, min: number, max: number): number {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    }
    return n;
}

// Never echo response bodies: OAuth/API errors may contain credentials or invoice data.
export async function request(url: string | URL, init: RequestInit, fetcher: Fetch = globalThis.fetch): Promise<Uint8Array> {
    let response: Response;
    try {
        response = await fetcher(url, {
            ...init, redirect: 'error', signal: AbortSignal.timeout(45_000),
        });
    } catch {
        throw new Error('ANAF request failed or timed out. Check connectivity and retry.');
    }
    if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 || response.status === 403
            ? 'Check authorization, company permissions and token expiry.'
            : response.status === 429 ? 'Rate limited. Wait before retrying.'
                : 'Retry later; no response body was logged.';
        throw new AnafHttpError(response.status, `ANAF returned HTTP ${response.status}. ${hint}`);
    }
    if (!response.body) throw new Error('ANAF returned an empty response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('Response exceeded the POC limit of 50 MiB.');
            }
            chunks.push(value);
        }
    } catch {
        throw new Error('Could not read ANAF response (interrupted or over 50 MiB).');
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}

function json(bytes: Uint8Array): unknown {
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
    catch { throw new Error('ANAF returned an unexpected non-JSON response. No body was logged.'); }
}

export class AnafClient {
    private base: string;
    private token: string;
    private fetcher: Fetch;

    constructor(environment: Environment, token: string, fetcher: Fetch = globalThis.fetch, base?: string) {
        if (environment !== 'prod' && environment !== 'test') throw new Error('Invalid ANAF environment.');
        if (!token.trim()) throw new Error('An access token is required. Run login first.');
        this.base = base ?? `https://api.anaf.ro/${environment}/FCTEL/rest/`;
        this.token = token;
        this.fetcher = fetcher;
    }

    async list(cif: string, days: number): Promise<Message[]> {
        digits(cif, 'CIF');
        integer(String(days), 'days', 1, 60);
        const url = new URL('listaMesajeFactura', this.base);
        url.search = new URLSearchParams({ cif, zile: String(days), filtru: 'P' }).toString();
        const data = json(await request(url, { headers: {
            Authorization: `Bearer ${this.token}`, Accept: 'application/json',
        } }, this.fetcher));
        if (!record(data)) throw new Error('Unexpected ANAF message-list structure.');
        if (typeof data.eroare === 'string' && /nu exista mesaje/i.test(data.eroare)) return [];
        if (data.eroare) throw new Error('ANAF reported an application error in the message list. No body was logged.');
        if (!Array.isArray(data.mesaje)) throw new Error('ANAF response has no message array.');
        return data.mesaje.map((entry: unknown) => {
            if (!record(entry) || typeof entry.id !== 'string' || typeof entry.tip !== 'string') {
                throw new Error('Unexpected ANAF message fields; refusing to guess download IDs.');
            }
            return {
                id: digits(entry.id, 'ANAF message ID'), tip: entry.tip,
                data_creare: typeof entry.data_creare === 'string' ? entry.data_creare : '',
                detalii: typeof entry.detalii === 'string' ? entry.detalii : '',
            };
        });
    }

    async download(id: string): Promise<Uint8Array> {
        digits(id, 'ANAF message ID');
        const url = new URL('descarcare', this.base);
        url.searchParams.set('id', id);
        const bytes = await request(url, { headers: {
            Authorization: `Bearer ${this.token}`, Accept: 'application/zip, application/octet-stream',
        } }, this.fetcher);
        // ANAF can return an application error with HTTP 200. Never save that as a ZIP.
        if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) {
            throw new Error('Download was not a ZIP archive; ANAF may have returned an application error.');
        }
        return bytes;
    }
}

export function receivedInvoices(messages: Message[]): Message[] {
    return messages.filter(m => m.tip.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase() === 'FACTURA PRIMITA');
}

export function addedTimestamp(value: string): string | null {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    if (Number(hour) > 23 || Number(minute) > 59 || (second && Number(second) > 59)) return null;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month)
        && date.getUTCDate() === Number(day) ? `${year}-${month}-${day}T${hour}:${minute}` : null;
}

export async function getTokens(
    credentials: { clientId: string; clientSecret: string },
    params: URLSearchParams,
    fetcher: Fetch = globalThis.fetch,
): Promise<Tokens> {
    const basic = Buffer.from(`${encodeURIComponent(credentials.clientId)}:${encodeURIComponent(credentials.clientSecret)}`).toString('base64');
    const data = json(await request(TOKEN_URL, {
        method: 'POST', headers: {
            Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        }, body: params.toString(),
    }, fetcher));
    if (!record(data) || typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('ANAF did not return an access token. No response body was logged.');
    }
    if (data.refresh_token !== undefined && typeof data.refresh_token !== 'string') {
        throw new Error('ANAF returned an unexpected refresh-token format.');
    }
    return {
        access_token: data.access_token,
        ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
        obtained_at: new Date().toISOString(),
        ...(typeof data.expires_in === 'number' && data.expires_in > 0 ? { expires_in: data.expires_in } : {}),
    };
}
