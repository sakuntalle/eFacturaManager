// Test-only process preload. No network request can reach ANAF.
globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.href === 'https://logincert.anaf.ro/anaf-oauth2/v1/token') {
        const params = new URLSearchParams(init.body);
        if (params.get('code') === 'denied') return Response.json({ error: 'private-test-response' }, { status: 400 });
        return Response.json({ access_token: 'integration-private-access', refresh_token: 'integration-private-refresh', expires_in: 3600 });
    }
    if (url.hostname === 'api.anaf.ro' && url.pathname.endsWith('/listaMesajeFactura')) return Response.json({ mesaje: [] });
    throw new Error('Unexpected outbound request blocked by OAuth integration test.');
};
