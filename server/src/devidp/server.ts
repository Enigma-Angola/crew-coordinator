/**
 * DEVELOPMENT AND TEST IDENTITY PROVIDER — NOT FOR PRODUCTION.
 *
 * A minimal OpenID Connect provider (authorization code + PKCE) so the application's real
 * OIDC client code path can be exercised locally and in automated tests without a
 * Keycloak/Entra ID tenant. It has no passwords: a developer picks a seeded identity and
 * the authentication method to simulate (password only, OTP, or hardware key), which lets
 * MFA and phishing-resistant enforcement be tested. Production deployments must use a
 * maintained IdP (see docs/SECURITY.md).
 */
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface DevIdpUser {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

interface Client {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  user: DevIdpUser;
  nonce?: string;
  codeChallenge: string;
  amr: string[];
  acr: string;
  authTime: number;
  expires: number;
}

const METHODS: Record<string, { amr: string[]; acr: string }> = {
  pwd: { amr: ['pwd'], acr: 'loa1' },
  otp: { amr: ['pwd', 'otp', 'mfa'], acr: 'loa2' },
  hwk: { amr: ['hwk', 'mfa'], acr: 'loa3' },
};

export async function buildDevIdp(opts: { issuer: string; users: DevIdpUser[]; clients: Client[] }) {
  if (process.env.NODE_ENV === 'production') throw new Error('The development IdP must never run in production');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, CodeRecord>();
  const app = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: opts.issuer,
    authorization_endpoint: `${opts.issuer}/authorize`,
    token_endpoint: `${opts.issuer}/token`,
    jwks_uri: `${opts.issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    claims_supported: ['sub', 'email', 'email_verified', 'name', 'amr', 'acr', 'auth_time'],
  }));

  app.get('/jwks', async () => ({ keys: [jwk] }));

  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const client = opts.clients.find((c) => c.clientId === q.client_id);
    if (!client || !client.redirectUris.includes(q.redirect_uri)) return reply.code(400).send('invalid client or redirect_uri');
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) return reply.code(400).send('PKCE S256 required');
    const hidden = Object.entries(q)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    const wantsMfa = (q.acr_values ?? '').includes('loa2') || (q.acr_values ?? '').includes('loa3');
    const rows = opts.users
      .map(
        (u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>
        <form method="post" action="/authorize/complete">${hidden}<input type="hidden" name="sub" value="${esc(u.sub)}">
        <button name="method" value="pwd">Password only</button>
        <button name="method" value="otp">Password + OTP</button>
        <button name="method" value="hwk">Security key</button></form></td></tr>`,
      )
      .join('');
    reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Development IdP</title>
      <style>body{font-family:system-ui;margin:2rem;color:#1d2433}table{border-collapse:collapse}td{padding:.4rem .8rem;border-bottom:1px solid #dde}
      .banner{background:#7a1f1f;color:#fff;padding:.8rem 1rem;border-radius:6px;margin-bottom:1rem}button{margin-right:.3rem}</style></head>
      <body><div class="banner" role="alert"><strong>Development identity provider — not for production.</strong>
      Simulates an external IdP so the OIDC flow, MFA and step-up checks can be exercised locally.</div>
      ${wantsMfa ? '<p><strong>The application requested multi-factor authentication.</strong></p>' : ''}
      ${q.prompt === 'login' ? '<p>Re-authentication requested by the application.</p>' : ''}
      <table><thead><tr><th>Name</th><th>Email</th><th>Sign in as</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
  });

  app.post('/authorize/complete', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const client = opts.clients.find((c) => c.clientId === b.client_id);
    if (!client || !client.redirectUris.includes(b.redirect_uri)) return reply.code(400).send('invalid client');
    const user = opts.users.find((u) => u.sub === b.sub);
    const method = METHODS[b.method];
    if (!user || !method) return reply.code(400).send('invalid user or method');
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      clientId: client.clientId,
      redirectUri: b.redirect_uri,
      user,
      nonce: b.nonce,
      codeChallenge: b.code_challenge,
      amr: method.amr,
      acr: method.acr,
      authTime: Math.floor(Date.now() / 1000),
      expires: Date.now() + 60_000,
    });
    const url = new URL(b.redirect_uri);
    url.searchParams.set('code', code);
    if (b.state) url.searchParams.set('state', b.state);
    url.searchParams.set('iss', opts.issuer);
    return reply.redirect(url.toString(), 302);
  });

  app.post('/token', async (req, reply) => {
    const b = req.body as Record<string, string>;
    let clientId = b.client_id;
    let secret = b.client_secret;
    const authz = req.headers.authorization;
    if (authz?.startsWith('Basic ')) {
      const [id, s] = Buffer.from(authz.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      clientId = id;
      secret = s;
    }
    const client = opts.clients.find((c) => c.clientId === clientId && c.clientSecret === secret);
    if (!client) return reply.code(401).send({ error: 'invalid_client' });
    const rec = codes.get(b.code);
    codes.delete(b.code); // single use
    if (!rec || rec.expires < Date.now() || rec.clientId !== clientId || rec.redirectUri !== b.redirect_uri) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const challenge = createHash('sha256').update(b.code_verifier ?? '').digest('base64url');
    if (challenge !== rec.codeChallenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE' });
    const idToken = await new SignJWT({
      email: rec.user.email,
      email_verified: rec.user.email_verified,
      name: rec.user.name,
      amr: rec.amr,
      acr: rec.acr,
      auth_time: rec.authTime,
      ...(rec.nonce ? { nonce: rec.nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
      .setIssuer(opts.issuer)
      .setSubject(rec.user.sub)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { access_token: randomBytes(24).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: idToken };
  });

  return app;
}
