import { runtime } from './runtime.js';

const app = await runtime().catch(() => { console.error('Worker startup failed. Check deployment configuration and database availability.'); process.exit(1); });
await app.queue.work('sync', async job => {
    if (!await app.repo.findCompany(job.companyId)) return;
    const item = await app.scope(job.companyId);
    await item.workflows.sync();
});
await app.queue.work('event', async job => {
    if (!job.eventId) throw new Error('Worker event ID missing.');
    if (!await app.repo.findCompany(job.companyId)) return;
    const item = await app.scope(job.companyId);
    await item.workflows.event(job.eventId);
});
let stopping = false;
let running = false;
async function tick() {
    if (running || stopping) return;
    running = true;
    try {
        const available = await app.connection.available();
        for (const company of await app.repo.companies()) {
            try {
                const item = await app.scope(company.id);
                if (available && await item.repo.due()) await app.queue.publish('sync', { companyId: company.id });
                await item.workflows.dispatch();
            } catch { console.error('Company scheduler dispatch failed; will retry on the next tick.'); }
        }
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
