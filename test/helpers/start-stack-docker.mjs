#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.START_STACK_TEST_LOG, `${JSON.stringify(args)}\n`);
if (args.includes('config')) {
    // Deliberately emit a synthetic secret to verify that config output stays private.
    process.stdout.write('synthetic-private-configuration');
    process.stderr.write('synthetic-private-configuration');
}
if (args.includes('up')) process.exit(Number(process.env.START_STACK_TEST_UP_CODE ?? 0));
if (args.includes('exec')) process.stdout.write('https://localhost:8765');
