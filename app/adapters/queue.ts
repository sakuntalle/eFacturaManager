import { PgBoss } from 'pg-boss';
import type { Job, JobQueue } from '../contracts.js';

export class PostgresJobQueue implements JobQueue {
    private boss: PgBoss;
    constructor(url: string, private scope: string) {
        this.boss = new PgBoss(url);
        this.boss.on('error', () => console.error('Job queue connection/processing error.'));
    }
    async start() {
        await this.boss.start();
        for (const kind of ['sync', 'event']) {
            await this.boss.createQueue(`${this.scope}-${kind}-dead`);
            await this.boss.createQueue(`${this.scope}-${kind}`, {
                policy: 'exclusive', retryLimit: 4, retryDelay: 5, retryBackoff: true,
                expireInSeconds: 300, deadLetter: `${this.scope}-${kind}-dead`,
            });
        }
    }
    async publish(kind: 'sync' | 'event', job: Job) {
        // A null send result means this key is already queued/active, which is also durable delivery.
        await this.boss.send(`${this.scope}-${kind}`, job, { singletonKey: job.eventId ?? job.companyId });
    }
    async work(kind: 'sync' | 'event', handler: (job: Job) => Promise<void>) {
        await this.boss.work<Job>(`${this.scope}-${kind}`, { batchSize: 1, pollingIntervalSeconds: 1 }, async jobs => {
            for (const job of jobs) await handler(job.data);
        });
    }
    async close() { await this.boss.stop({ graceful: true }); }
}
