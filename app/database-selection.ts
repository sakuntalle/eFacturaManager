export function selectedDatabaseUrl(baseUrl: string, name?: string): string {
    if (name === undefined || name === '') return baseUrl;
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
        throw new Error('APP_DATABASE_NAME must be a lowercase PostgreSQL database name (up to 63 characters).');
    }
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    return url.toString();
}
