import { config } from '../config.js';
import { DEV_USERS } from '../seed/demo.js';
import { buildDevIdp } from './server.js';

const dev = config.providers.find((p) => p.id === 'dev');
if (!dev) throw new Error('No "dev" provider configured in OIDC_PROVIDERS');
const app = await buildDevIdp({
  issuer: dev.issuer,
  users: DEV_USERS.map((u) => ({ sub: u.sub, email: u.email, email_verified: !u.unverified, name: u.name })),
  clients: [{ clientId: dev.clientId, clientSecret: dev.clientSecret ?? '', redirectUris: [`${config.APP_BASE_URL}/auth/callback`] }],
});
await app.listen({ port: Number(new URL(dev.issuer).port || 4000), host: '127.0.0.1' });
console.log(`Development IdP (NOT FOR PRODUCTION) listening at ${dev.issuer}`);
