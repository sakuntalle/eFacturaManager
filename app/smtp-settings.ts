export type SmtpSettings = {
    host: string; port: number; secure: boolean; requireTLS: boolean;
    user: string; password: string; from: string; to: string; configured: boolean;
};
export type SmtpInput = Omit<SmtpSettings, 'password' | 'configured' | 'to'> & { password?: string };

export function defaultSmtpSettings(): SmtpSettings {
    return { host: '', port: 587, secure: false, requireTLS: true, user: '', password: '',
        from: '', to: '', configured: false };
}

export function smtpInput(value: Record<string, unknown>): SmtpInput {
    const text = (name: string, maximum: number) => {
        const input = value[name];
        if (typeof input !== 'string' || input.length > maximum || /[\u0000-\u001f\u007f]/u.test(input)) {
            throw new Error('Enter valid SMTP settings.');
        }
        return input.trim();
    };
    const host = text('host', 253);
    if (!host || !/^[a-zA-Z0-9.:[\]_-]+$/.test(host)) throw new Error('Enter an SMTP hostname.');
    if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) {
        throw new Error('SMTP port must be an integer from 1 to 65535.');
    }
    if (typeof value.secure !== 'boolean' || typeof value.requireTLS !== 'boolean') {
        throw new Error('Choose the SMTP TLS settings.');
    }
    const user = text('user', 254);
    const from = text('from', 320);
    const sender = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(from);
    const address = sender?.[1] ?? sender?.[2] ?? '';
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new Error('Enter a valid sender email address.');
    if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length > 1024
        || /[\u0000\r\n]/u.test(value.password))) throw new Error('Enter a valid SMTP password.');
    return { host, port: Number(value.port), secure: value.secure, requireTLS: value.requireTLS,
        user, from, ...(value.password ? { password: value.password as string } : {}) };
}

export function publicSmtp(settings: SmtpSettings) {
    const { password, to, ...visible } = settings;
    return { ...visible, hasPassword: !!password };
}
