import * as client from 'openid-client';
import { config, type IdpConfig } from '../config.js';

const cache = new Map<string, Promise<client.Configuration>>();

export function getIdp(id: string): IdpConfig | undefined {
  return config.providers.find((p) => p.id === id);
}

export function redirectUri() {
  return `${config.APP_BASE_URL}/auth/callback`;
}

/** Discovers (and caches) the OIDC configuration of a configured identity provider. */
export function idpConfiguration(idp: IdpConfig) {
  let c = cache.get(idp.id);
  if (!c) {
    const insecure = !config.isProd && idp.issuer.startsWith('http://');
    c = client
      .discovery(new URL(idp.issuer), idp.clientId, idp.clientSecret, undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((err) => {
        cache.delete(idp.id);
        throw err;
      });
    cache.set(idp.id, c);
  }
  return c;
}

export function clearIdpCache() {
  cache.clear();
}

export async function buildLoginUrl(
  idp: IdpConfig,
  p: { state: string; nonce: string; codeVerifier: string; requireMfa: boolean; stepUp: boolean; loginHint?: string },
) {
  const cfg = await idpConfiguration(idp);
  const params: Record<string, string> = {
    redirect_uri: redirectUri(),
    scope: idp.scopes,
    code_challenge: await client.calculatePKCECodeChallenge(p.codeVerifier),
    code_challenge_method: 'S256',
    state: p.state,
    nonce: p.nonce,
  };
  if (p.requireMfa && idp.mfaAcrValues) params.acr_values = idp.mfaAcrValues;
  if (p.stepUp) {
    params.prompt = 'login';
    params.max_age = '0';
  }
  if (p.loginHint) params.login_hint = p.loginHint;
  return client.buildAuthorizationUrl(cfg, params).toString();
}

export async function exchangeCode(idp: IdpConfig, currentUrl: URL, checks: { state: string; nonce: string; codeVerifier: string; stepUp: boolean }) {
  const cfg = await idpConfiguration(idp);
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: checks.codeVerifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
    ...(checks.stepUp ? { maxAge: config.STEP_UP_MAX_AGE_SECONDS } : {}),
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('missing id token claims');
  return {
    sub: String(claims.sub),
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : null,
    amr: Array.isArray(claims.amr) ? claims.amr.map(String) : [],
    acr: typeof claims.acr === 'string' ? claims.acr : null,
    authTime: typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : new Date(),
  };
}

export { client as oidc };
