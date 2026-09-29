import { createHash } from 'node:crypto';
import { AnafHttpError, AnafNetworkError } from '../src/anaf.ts';

type Context = {
    entityId?: string;
    eventId?: string;
    kind?: 'sync' | 'invoice.pdf' | 'invoice.email';
    count?: number;
    days?: number;
    durationMs?: number;
    httpStatus?: number;
    operation?: 'authentication' | 'connection' | 'companies' | 'invoices' | 'sync' | 'settings' | 'events' | 'mock' | 'other';
};

export function diagnosticReference(value: string) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeContext(context: Context) {
    return {
        ...(context.entityId ? { entity: diagnosticReference(context.entityId) } : {}),
        ...(context.eventId ? { event: diagnosticReference(context.eventId) } : {}),
        ...(context.kind ? { kind: context.kind } : {}),
        ...(context.count !== undefined ? { count: context.count } : {}),
        ...(context.days !== undefined ? { days: context.days } : {}),
        ...(context.durationMs !== undefined ? { durationMs: context.durationMs } : {}),
        ...(context.httpStatus !== undefined ? { httpStatus: context.httpStatus } : {}),
        ...(context.operation ? { operation: context.operation } : {}),
    };
}

export function failureDetails(error: unknown) {
    const value = typeof error === 'object' && error !== null ? error as { code?: unknown; status?: unknown } : {};
    const code = typeof value.code === 'string' ? value.code : '';
    const httpStatus = error instanceof AnafHttpError && Number.isInteger(error.status)
        && error.status >= 100 && error.status <= 599 ? error.status : undefined;
    if (httpStatus) return { category: 'anaf_http', httpStatus };
    if (error instanceof AnafNetworkError) return { category: 'anaf_network',
        ...(error.networkCode ? { networkCode: error.networkCode } : {}) };
    if (/^[0-9A-Z]{5}$/.test(code) && (/^[0-9]/.test(code)
        || typeof (value as { severity?: unknown }).severity === 'string')) {
        return { category: 'database', databaseCode: code };
    }
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code)) {
        return { category: 'network', networkCode: code };
    }
    return { category: 'unexpected' };
}

export function logFailure(module: 'web' | 'worker' | 'queue' | 'email' | 'mock', stage: string,
    error: unknown, context: Context = {}) {
    console.error(JSON.stringify({ level: 'error', module, stage, ...safeContext(context), ...failureDetails(error) }));
}

export function logInfo(module: 'web' | 'worker', stage: string, context: Context = {}) {
    console.info(JSON.stringify({ level: 'info', module, stage, ...safeContext(context) }));
}
