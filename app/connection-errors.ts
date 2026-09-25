// Fixed application messages only. Never display ANAF's error_description or raw responses.
const messages = {
    invalid_return: 'The ANAF return could not be validated. Start a new connection from this browser.',
    attempt_missing: 'This ANAF connection attempt has already ended. Choose Connect to ANAF again.',
    browser_mismatch: 'The ANAF return does not match this browser’s latest connection attempt. Please start again.',
    attempt_expired: 'The ANAF connection attempt expired. Choose Connect to ANAF again.',
    session_expired: 'Your app session expired during authorization. Sign in again, then connect to ANAF.',
    authorization_declined: 'ANAF returned an authorization error before a connection could be established. Try again with your qualified certificate available.',
    provider_access_denied: 'ANAF declined authorization. If your certificate works in SPV but ANAF shows “Your session is finished” during connection, check the OAuth app registration and contact ANAF support about the certificate gateway.',
    provider_invalid_request: 'ANAF rejected the authorization request. Ask the deployment administrator to check the application registration and callback configuration.',
    provider_invalid_client: 'ANAF did not accept the application registration. Ask the deployment administrator to check the server configuration.',
    provider_unauthorized_client: 'ANAF did not authorize this application. Ask the deployment administrator to check its registration.',
    provider_unsupported_response_type: 'ANAF did not accept the authorization flow. Ask the deployment administrator to check its registration.',
    provider_invalid_scope: 'ANAF rejected the requested access. Ask the deployment administrator to check its registration.',
    provider_server_error: 'ANAF reported a service error during authorization. Please try again later.',
    provider_temporarily_unavailable: 'ANAF authorization is temporarily unavailable. Please try again later.',
    token_exchange: 'ANAF authorization returned, but the connection could not be completed. Start a fresh connection and try again.',
    company_access: 'ANAF authorization returned, but invoice access for this company could not be verified. Check your company access or try again later.',
    save_connection: 'The app could not save the ANAF connection. Please try again or contact the deployment administrator.',
    start_failed: 'The app could not start ANAF authorization. Please try again or contact the deployment administrator.',
    storage_or_processing: 'The app could not process the ANAF return. Please try again or contact the deployment administrator.',
} as const;
export type ConnectionFailure = keyof typeof messages;
export function connectionFailureMessage(reason: string | null): string {
    return reason && Object.hasOwn(messages, reason) ? messages[reason as ConnectionFailure]
        : 'ANAF connection did not complete. Please try again.';
}
export function providerFailure(error: string | null): ConnectionFailure {
    // Return a value from the fixed allowlist, never arbitrary provider input.
    switch (error) {
        case 'access_denied': return 'provider_access_denied';
        case 'invalid_request': return 'provider_invalid_request';
        case 'invalid_client': return 'provider_invalid_client';
        case 'unauthorized_client': return 'provider_unauthorized_client';
        case 'unsupported_response_type': return 'provider_unsupported_response_type';
        case 'invalid_scope': return 'provider_invalid_scope';
        case 'server_error': return 'provider_server_error';
        case 'temporarily_unavailable': return 'provider_temporarily_unavailable';
        default: return 'authorization_declined';
    }
}
