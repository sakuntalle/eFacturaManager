import { runtime } from './runtime.js';
import { logFailure, logInfo } from './diagnostics.js';

const app = await runtime().catch(error => { logFailure('worker', 'startup', error); process.exit(1); });
await app.queue.work('sync', async job => {
    try {
        if (!await app.repo.findCompany(job.companyId)) return;
        const item = await app.scope(job.companyId);
        await item.workflows.sync();
    } catch (error) {
        logFailure('worker', 'sync_job', error, { entityId: job.companyId, kind: 'sync' });
        throw error;
    }
});
await app.queue.work('event', async job => {
    try {
        if (!job.eventId) throw new Error('Worker event ID missing.');
        if (!await app.repo.findCompany(job.companyId)) return;
        const item = await app.scope(job.companyId);
        await item.workflows.event(job.eventId);
    } catch (error) {
        logFailure('worker', 'event_job', error, { entityId: job.companyId, eventId: job.eventId });
        throw error;
    }
});
let stopping = false;
let running = false;
async function tick() {
    if (running || stopping) return;
    running = true;
    try {
        for (const company of await app.repo.companies()) {
            try {
                const item = await app.scope(company.id);
                if (await item.connection.available() && await item.repo.due()) {
                    await app.queue.publish('sync', { companyId: company.id });
                }
                await item.workflows.dispatch();
            } catch (error) { logFailure('worker', 'company_scheduler', error, { entityId: company.id }); }
        }
    } catch (error) { logFailure('worker', 'scheduler', error); }
    finally { running = false; }
}
await tick();
const timer = setInterval(tick, 2000);
logInfo('worker', 'started');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    stopping = true;
    clearInterval(timer);
    while (running) await new Promise(resolve => setTimeout(resolve, 50));
    await app.queue.close();
    await app.repo.close();
    process.exit(0);
});
