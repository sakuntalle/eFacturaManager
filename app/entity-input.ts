export type EntityInput = {
    name: string;
    kind: 'company' | 'individual';
    cif: string;
    emailTo: string;
    emailEnabled: boolean;
    pollSeconds: number;
};

export function entityInput(value: Record<string, unknown>): EntityInput {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 160
        || /[\u0000-\u001f\u007f]/u.test(value.name)) throw new Error('Enter a name of at most 160 characters.');
    if (value.kind !== 'company' && value.kind !== 'individual') throw new Error('Choose company or individual.');
    if (typeof value.cif !== 'string') throw new Error('Enter a fiscal identifier.');
    const cif = value.kind === 'company' ? value.cif.trim().replace(/^RO/i, '') : value.cif.trim();
    if (!/^\d{1,30}$/.test(cif) || (value.kind === 'individual' && cif.length !== 13)) {
        throw new Error(value.kind === 'individual' ? 'CNP must contain 13 digits.' : 'CIF must contain only digits.');
    }
    if (typeof value.emailTo !== 'string' || value.emailTo.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.emailTo)) throw new Error('Enter a valid notification email address.');
    if (typeof value.emailEnabled !== 'boolean') throw new Error('Choose whether email notifications are enabled.');
    if (!Number.isInteger(value.pollSeconds) || (value.pollSeconds as number) < 15 || (value.pollSeconds as number) > 86400) {
        throw new Error('Polling interval must be 15–86400 seconds.');
    }
    return { name: value.name.trim(), kind: value.kind, cif, emailTo: value.emailTo.trim(),
        emailEnabled: value.emailEnabled, pollSeconds: value.pollSeconds as number };
}
