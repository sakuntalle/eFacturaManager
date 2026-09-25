import { runtime } from './runtime.js';

const app = await runtime().catch(() => { console.error('Worker startup failed. Check deployment configuration and database availability.'); process.exit(1); });
const company = await app.repo.company();
await app.queue.work('sync', async job => {
    if (job.companyId !== company.id) throw new Error('Worker company mismatch.');
    await app.workflows.sync();
});
await app.queue.work('event', async job => {
    if (job.companyId !== company.id || !job.eventId) throw new Error('Worker event scope mismatch.');
    await app.workflows.event(job.eventId);
});
let stopping = false;
let running = false;
async function tick() {
    if (running || stopping) return;
    running = true;
    try {
        if (await app.connection.available() && await app.repo.due()) await app.queue.publish('sync', { companyId: company.id });
        await app.workflows.dispatch();
    } catch { console.error('Scheduler/outbox dispatch failed; will retry on the next tick.'); }
    finally { running = false; }
}
await tick();
const timer = setInterval(tick, 2000);
console.log(`Worker running: ANAF_MODE=${app.cfg.mode}, email=${app.cfg.emailEnabled ? 'SMTP' : 'disabled'}.`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    stopping = true;
    clearInterval(timer);
    while (running) await new Promise(resolve => setTimeout(resolve, 50));
    await app.queue.close();
    await app.repo.close();
    process.exit(0);
});
