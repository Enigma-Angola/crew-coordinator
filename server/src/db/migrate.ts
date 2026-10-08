import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies pending SQL migrations using the owner connection. */
export async function migrate(connectionString: string, log = console.log) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

/** Development helper: create the runtime login role as a member of cc_app. */
export async function ensureAppLogin(connectionString: string, appUrl: string) {
  const u = new URL(appUrl);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const user = decodeURIComponent(u.username);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    const pw = decodeURIComponent(u.password).replace(/'/g, "''");
    if (!exists.rowCount) await client.query(`CREATE ROLE "${user}" LOGIN NOBYPASSRLS PASSWORD '${pw}' IN ROLE cc_app`);
  } finally {
    await client.end();
  }
}
