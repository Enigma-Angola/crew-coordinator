import { z } from 'zod';

const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  issuer: z.string().url(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  scopes: z.string().default('openid email profile'),
  // Values of the "amr" claim this IdP uses to signal multi-factor / phishing-resistant authentication.
  mfaAmr: z.array(z.string()).default(['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'sc']),
  phishingResistantAmr: z.array(z.string()).default(['hwk', 'sc']),
  // acr_values to request when MFA is required (IdP specific, e.g. a Keycloak LoA level).
  mfaAcrValues: z.string().optional(),
});

export type IdpConfig = z.infer<typeof providerSchema>;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().default('postgres://cc_app_login:cc_app_dev@localhost:5432/crew_coordinator'),
  MIGRATION_DATABASE_URL: z.string().default('postgres://postgres@localhost:5432/crew_coordinator'),
  OIDC_PROVIDERS: z.string().default(
    JSON.stringify([{ id: 'dev', name: 'Development IdP', issuer: 'http://localhost:4000', clientId: 'crew-coordinator', clientSecret: 'dev-secret' }]),
  ),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  URL_SIGNING_KEY: z.string().default(''),
  STORAGE_DIR: z.string().default('./var/storage'),
  MALWARE_SCAN_MODE: z.enum(['clamav', 'none', 'dev-allow-all']).default('none'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().default(12),
  STEP_UP_MAX_AGE_SECONDS: z.coerce.number().default(600),
  EMAIL_PROVIDER: z.enum(['microsoft', 'google', 'none']).default('microsoft'),
  MS_CLIENT_ID: z.string().default(''),
  MS_CLIENT_SECRET: z.string().default(''),
  MS_TENANT: z.string().default('organizations'),
  MS_AUTHORITY_BASE: z.string().default('https://login.microsoftonline.com'),
  GRAPH_BASE_URL: z.string().default('https://graph.microsoft.com/v1.0'),
  MAX_ATTACHMENT_TOTAL_BYTES: z.coerce.number().default(20 * 1024 * 1024),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  TRUST_PROXY: z.coerce.boolean().default(false),
});

function load() {
  const env = schema.parse(process.env);
  const providers = z.array(providerSchema).parse(JSON.parse(env.OIDC_PROVIDERS));
  const isProd = env.NODE_ENV === 'production';

  const devKey = (label: string) => Buffer.from(`dev-only-${label}-key-not-for-production!!`).subarray(0, 32);
  const key = (value: string, label: string) => {
    if (value) {
      const buf = Buffer.from(value, 'base64');
      if (buf.length !== 32) throw new Error(`${label} must be 32 bytes, base64 encoded`);
      return buf;
    }
    if (isProd) throw new Error(`${label} is required in production`);
    return devKey(label);
  };

  if (isProd) {
    if (env.MALWARE_SCAN_MODE === 'dev-allow-all') throw new Error('MALWARE_SCAN_MODE=dev-allow-all is not allowed in production');
    if (!env.APP_BASE_URL.startsWith('https://')) throw new Error('APP_BASE_URL must use https in production');
    for (const p of providers) {
      if (!p.issuer.startsWith('https://')) throw new Error(`IdP ${p.id} must use https in production`);
    }
  }

  return {
    ...env,
    isProd,
    providers,
    tokenKey: key(env.TOKEN_ENCRYPTION_KEY, 'TOKEN_ENCRYPTION_KEY'),
    urlKey: key(env.URL_SIGNING_KEY, 'URL_SIGNING_KEY'),
    cookieName: isProd ? '__Host-cc_sid' : 'cc_sid',
    privilegedRoles: ['org_admin', 'manager', 'coordinator', 'hr_compliance', 'auditor'] as string[],
  };
}

export type Config = ReturnType<typeof load>;
export let config: Config = load();

/** Used by tests to rebuild configuration after changing process.env. */
export function reloadConfig() {
  config = load();
  return config;
}
