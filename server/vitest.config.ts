import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      APP_BASE_URL: 'http://app.test',
      DATABASE_URL: 'postgres://cc_app_login:cc_app_dev@localhost:5432/crew_coordinator_test',
      MIGRATION_DATABASE_URL: 'postgres://postgres@localhost:5432/crew_coordinator_test',
      OIDC_PROVIDERS: JSON.stringify([{ id: 'dev', name: 'Test IdP', issuer: 'http://localhost:4501', clientId: 'crew-coordinator', clientSecret: 'test-secret', mfaAcrValues: 'loa2' }]),
      STORAGE_DIR: '/tmp/cc-test-storage',
      MALWARE_SCAN_MODE: 'dev-allow-all',
      MS_CLIENT_ID: 'graph-client',
      MS_CLIENT_SECRET: 'graph-secret',
      MS_AUTHORITY_BASE: 'http://localhost:4510',
      GRAPH_BASE_URL: 'http://localhost:4510/v1.0',
      ANTHROPIC_BASE_URL: 'http://localhost:4520',
      ANTHROPIC_API_KEY: 'test-key',
    },
  },
});
