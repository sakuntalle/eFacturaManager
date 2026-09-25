export function formatInvoiceDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

export function formatAddedDate(value: string): string {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
    return match ? `${formatInvoiceDate(match[1])} ${match[2]}`
        : `${formatInvoiceDate(value)} (time unavailable)`;
}

export function formatAppDateTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest',
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(date);
    const part = (name: string) => parts.find(item => item.type === name)?.value ?? '';
    return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}
