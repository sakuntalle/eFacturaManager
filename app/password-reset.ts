import { createHash, randomBytes } from 'node:crypto';

export const PASSWORD_RESET_DURATION = 30 * 60 * 1000;

export type PasswordResetStore = {
    registeredRecoveryEmail(email: string): Promise<string | null>;
    issuePasswordReset(tokenHash: string, email: string, expiresAt: Date): Promise<void>;
    consumePasswordReset(tokenHash: string, passwordHash: string): Promise<boolean>;
};

export type PasswordResetMailer = {
    sendPasswordReset(email: string, link: string): Promise<void>;
};

export function resetTokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export class PasswordResets {
    constructor(private store: PasswordResetStore, private mailer: PasswordResetMailer,
        private publicUrl: string) {}

    async request(email: unknown): Promise<void> {
        if (typeof email !== 'string' || email.length > 254
            || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
        const recipient = await this.store.registeredRecoveryEmail(email.trim());
        if (!recipient) return;
        const token = randomBytes(32).toString('base64url');
        await this.store.issuePasswordReset(resetTokenHash(token), recipient,
            new Date(Date.now() + PASSWORD_RESET_DURATION));
        const url = new URL(this.publicUrl);
        url.searchParams.set('reset', token);
        await this.mailer.sendPasswordReset(recipient, url.toString());
    }

    async complete(token: unknown, nextPasswordHash: string): Promise<boolean> {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        return this.store.consumePasswordReset(resetTokenHash(token), nextPasswordHash);
    }
}
