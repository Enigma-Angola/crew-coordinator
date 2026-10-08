import pg from 'pg';
import { migrate, ensureAppLogin } from '../src/db/migrate.js';

export default async function setup() {
  const admin = new pg.Client({ connectionString: 'postgres://postgres@localhost:5432/postgres' });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS crew_coordinator_test WITH (FORCE)');
  await admin.query('CREATE DATABASE crew_coordinator_test');
  await admin.end();
  const url = 'postgres://postgres@localhost:5432/crew_coordinator_test';
  await migrate(url, () => undefined);
  await ensureAppLogin(url, 'postgres://cc_app_login:cc_app_dev@localhost:5432/crew_coordinator_test');
}
