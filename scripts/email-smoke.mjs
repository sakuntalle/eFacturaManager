import nodemailer from 'nodemailer';

const env = process.env;
const localHosts = new Set(['mailpit', 'localhost', '127.0.0.1']);
if (env.EMAIL_ENABLED !== 'true' || !env.SMTP_HOST || localHosts.has(env.SMTP_HOST)
    || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.EMAIL_FROM || !env.EMAIL_TO
    || /example\.(com|test|org)/i.test(`${env.EMAIL_FROM} ${env.EMAIL_TO}`)) {
    console.error('Real email settings are incomplete. Check EMAIL_ENABLED, SMTP, sender and recipient in .env.');
    process.exitCode = 1;
} else {
    const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT),
        secure: env.SMTP_SECURE === 'true',
        requireTLS: env.SMTP_REQUIRE_TLS === 'true',
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
    });
    try {
        const result = await transport.sendMail({
            from: env.EMAIL_FROM,
            to: env.EMAIL_TO,
            subject: 'eFactura Manager email delivery test',
            text: 'This is a test of eFactura Manager email delivery. No invoice was created.',
        });
        if (result.accepted?.length !== 1 || result.rejected?.length) throw new Error('Recipient was not accepted.');
        console.log('Test email accepted by the configured SMTP server. Check the destination inbox.');
    } catch {
        console.error('Test email failed. Check the SMTP provider, app password, sender and recipient.');
        process.exitCode = 1;
    } finally {
        transport.close();
    }
}
