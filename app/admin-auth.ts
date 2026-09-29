import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const ADMIN_USERNAME = 'admin';

export function temporaryPassword() {
    return randomBytes(9).toString('base64url');
}

export function passwordHash(password: string) {
    const salt = randomBytes(16);
    const digest = scryptSync(password, salt, 64);
    return `scrypt:${salt.toString('hex')}:${digest.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string) {
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/.test(parts[1]!)
        || !/^[a-f0-9]{128}$/.test(parts[2]!)) return false;
    const expected = Buffer.from(parts[2]!, 'hex');
    const actual = scryptSync(password, Buffer.from(parts[1]!, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
}
