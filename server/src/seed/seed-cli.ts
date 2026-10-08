import { config } from '../config.js';
import { refreshInsights } from '../domain/insights.js';
import { withTx, closePool } from '../db/pool.js';
import { seedDemo } from './demo.js';

if (config.isProd) throw new Error('Refusing to load demonstration data in production');
const ids = await seedDemo(config.MIGRATION_DATABASE_URL, { reset: process.argv.includes('--reset') });
for (const org of [ids.orgA, ids.orgB]) await withTx({ orgId: org }, (db) => refreshInsights(db, org));
await closePool();
console.log('demo data loaded:', { orgA: ids.orgA, orgB: ids.orgB });
