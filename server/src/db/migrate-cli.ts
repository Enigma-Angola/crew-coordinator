import { config } from '../config.js';
import { ensureAppLogin, migrate } from './migrate.js';

await migrate(config.MIGRATION_DATABASE_URL);
if (!config.isProd) await ensureAppLogin(config.MIGRATION_DATABASE_URL, config.DATABASE_URL);
console.log('migrations complete');
