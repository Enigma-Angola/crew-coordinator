import { config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { decryptSecret, encryptSecret } from '../../util/crypto.js';
import { oidc } from '../../auth/oidc.js';
import { ProviderRateLimited, ReauthorisationRequired, SendFailed, SendUncertain, type InboundEmail, type OutboundEmail } from './types.js';

/**
 * Microsoft 365 / Outlook connector using Microsoft Graph (delegated permissions).
 *
 * Least privilege: Mail.Send to submit, Mail.Read to synchronise selected folders and to
 * reconcile uncertain sends, offline_access for refresh tokens and User.Read to identify the
 * mailbox. Shared mailboxes add Mail.Send.Shared and Mail.Read.Shared. No mailbox password
 * is ever collected, and Mail.ReadWrite is not requested.
 */
export const GRAPH_SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'];
export const GRAPH_SHARED_SCOPES = ['Mail.Read.Shared', 'Mail.Send.Shared'];
/** sendMail accepts at most ~4 MB per request; we keep a margin for base64 and JSON overhead. */
export const GRAPH_SENDMAIL_ATTACHMENT_LIMIT = 2_900_000;
const PROP_ID = 'String {00020329-0000-0000-C000-000000000046} Name CrewCoordinatorKey';

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface MailboxRow {
  id: string;
  org_id: string;
  address: string;
  kind: 'individual' | 'shared';
  status: string;
  token_ciphertext: Buffer | null;
  sync_folders: string[];
  sync_state: Record<string, string>;
}

const authority = () => `${config.MS_AUTHORITY_BASE}/${config.MS_TENANT}/oauth2/v2.0`;
export const graphRedirectUri = () => `${config.APP_BASE_URL}/api/mailboxes/oauth/callback`;

export function graphAvailable() {
  return !!(config.MS_CLIENT_ID && config.MS_CLIENT_SECRET);
}

export async function graphAuthorizeUrl(p: { state: string; codeVerifier: string; shared: boolean; loginHint?: string }) {
  const url = new URL(`${authority()}/authorize`);
  url.searchParams.set('client_id', config.MS_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', graphRedirectUri());
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', [...GRAPH_SCOPES, ...(p.shared ? GRAPH_SHARED_SCOPES : [])].join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', await oidc.calculatePKCECodeChallenge(p.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.MS_CLIENT_ID, client_secret: config.MS_CLIENT_SECRET, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (json.error === 'invalid_grant' || json.error === 'interaction_required') throw new ReauthorisationRequired();
    throw new Error(`token endpoint error: ${json.error ?? res.status}`);
  }
  return {
    access_token: json.access_token as string,
    refresh_token: (json.refresh_token as string) ?? body.refresh_token,
    expires_at: Date.now() + (Number(json.expires_in ?? 3600) - 60) * 1000,
    scope: String(json.scope ?? ''),
  };
}

export async function graphExchangeCode(code: string, codeVerifier: string) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: graphRedirectUri(), code_verifier: codeVerifier });
  const me = await fetch(`${config.GRAPH_BASE_URL}/me?$select=mail,userPrincipalName`, { headers: { authorization: `Bearer ${t.access_token}` } }).then((r) => r.json() as any);
  return { tokens: t, address: String(me.mail ?? me.userPrincipalName ?? '').toLowerCase() };
}

export function sealTokens(mailboxId: string, t: TokenSet) {
  return encryptSecret(JSON.stringify(t), `mailbox:${mailboxId}`);
}

export class GraphClient {
  private tokens: TokenSet | null = null;
  constructor(private db: Db, private box: MailboxRow) {}

  private base() {
    return this.box.kind === 'shared' ? `${config.GRAPH_BASE_URL}/users/${encodeURIComponent(this.box.address)}` : `${config.GRAPH_BASE_URL}/me`;
  }

  private async accessToken(force = false) {
    if (!this.box.token_ciphertext) throw new ReauthorisationRequired();
    if (!this.tokens) this.tokens = JSON.parse(decryptSecret(this.box.token_ciphertext, `mailbox:${this.box.id}`));
    if (force || this.tokens!.expires_at < Date.now()) {
      try {
        const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens!.refresh_token });
        this.tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at };
        const sealed = sealTokens(this.box.id, this.tokens);
        await this.db.query('UPDATE mailbox_connections SET token_ciphertext = $2 WHERE id = $1', [this.box.id, sealed]);
        this.box.token_ciphertext = sealed;
      } catch (e) {
        if (e instanceof ReauthorisationRequired) {
          await this.db.query("UPDATE mailbox_connections SET status = 'reauthorisation_required', last_error = 'authorisation expired or revoked' WHERE id = $1", [this.box.id]);
        }
        throw e;
      }
    }
    return this.tokens!.access_token;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retried = false): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.base()}${path}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && !retried) {
      await this.accessToken(true);
      return this.request(method, path, body, headers, true);
    }
    if (res.status === 429 || res.status === 503) throw new ProviderRateLimited(Number(res.headers.get('retry-after') ?? 30));
    return res;
  }

  /**
   * Submits a message. The idempotency key travels as a MAPI extended property and an
   * internet header so that, after an ambiguous failure, we can look in Sent Items to learn
   * whether the provider accepted it before retrying — preventing duplicate emails.
   */
  async send(m: OutboundEmail) {
    const size = m.attachments.reduce((n, a) => n + a.content.length, 0);
    if (size > GRAPH_SENDMAIL_ATTACHMENT_LIMIT) throw new SendFailed('attachment_limit_exceeded');
    const message = {
      subject: m.subject,
      body: { contentType: 'Text', content: m.text },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: m.cc.map((address) => ({ emailAddress: { address } })),
      ...(this.box.kind === 'shared' ? { from: { emailAddress: { address: this.box.address } } } : {}),
      internetMessageHeaders: [{ name: 'X-CrewCoord-Key', value: m.idempotencyKey }],
      singleValueExtendedProperties: [{ id: PROP_ID, value: m.idempotencyKey }],
      attachments: m.attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.content.toString('base64') })),
    };
    let res: Response;
    try {
      res = await this.request('POST', '/sendMail', { message, saveToSentItems: true });
    } catch (e) {
      if (e instanceof ProviderRateLimited) throw new SendFailed('rate_limited', true, e.retryAfterSeconds);
      if (e instanceof ReauthorisationRequired) throw new SendFailed('reauthorisation_required');
      throw new SendUncertain((e as Error).name === 'TimeoutError' ? 'timeout' : 'network_error');
    }
    if (res.status === 202) return { accepted: true };
    if (res.status >= 500) throw new SendUncertain(`provider_${res.status}`);
    const err: any = await res.json().catch(() => ({}));
    throw new SendFailed(String(err?.error?.code ?? `http_${res.status}`).slice(0, 80));
  }

  /** Finds a submitted message in Sent Items by idempotency key. */
  async findSent(key: string): Promise<{ providerMessageId: string; internetMessageId: string; conversationId: string; sentAt: string } | null> {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${PROP_ID}' and ep/value eq '${key.replace(/'/g, "''")}')`;
    const res = await this.request('GET', `/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filter)}&$select=id,internetMessageId,conversationId,sentDateTime&$top=1`);
    if (!res.ok) throw new Error(`sent lookup failed: ${res.status}`);
    const json: any = await res.json();
    const m = json.value?.[0];
    return m ? { providerMessageId: m.id, internetMessageId: m.internetMessageId, conversationId: m.conversationId, sentAt: m.sentDateTime } : null;
  }

  /** Incremental sync of the configured folders only (delta query). */
  async *sync(): AsyncGenerator<InboundEmail> {
    const state = { ...(this.box.sync_state ?? {}) };
    for (const folder of this.box.sync_folders) {
      let next: string | null = state[folder] ?? `/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=id&$top=50`;
      while (next) {
        const res = await this.request('GET', next);
        if (res.status === 410) {
          // Delta token expired: restart this folder from a fresh delta.
          next = `/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=id&$top=50`;
          continue;
        }
        if (!res.ok) throw new Error(`delta failed: ${res.status}`);
        const page: any = await res.json();
        for (const item of page.value ?? []) {
          if (item['@removed']) continue;
          const full = await this.fetchMessage(item.id);
          if (full) yield full;
        }
        if (page['@odata.nextLink']) next = page['@odata.nextLink'];
        else {
          if (page['@odata.deltaLink']) state[folder] = page['@odata.deltaLink'];
          next = null;
        }
      }
      await this.db.query('UPDATE mailbox_connections SET sync_state = $2 WHERE id = $1', [this.box.id, state]);
    }
  }

  async fetchMessage(id: string): Promise<InboundEmail | null> {
    const res = await this.request(
      'GET',
      `/messages/${encodeURIComponent(id)}?$select=id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,internetMessageHeaders,hasAttachments`,
      undefined,
      { prefer: 'outlook.body-content-type="text"' },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`message fetch failed: ${res.status}`);
    const m: any = await res.json();
    const header = (name: string) => (m.internetMessageHeaders ?? []).find((h: any) => h.name.toLowerCase() === name)?.value ?? null;
    const attachments: InboundEmail['attachments'] = [];
    if (m.hasAttachments) {
      const ar = await this.request('GET', `/messages/${encodeURIComponent(id)}/attachments`);
      if (ar.ok) {
        const list: any = await ar.json();
        for (const a of list.value ?? []) {
          if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || !a.contentBytes) continue;
          attachments.push({ filename: a.name, contentType: a.contentType, content: Buffer.from(a.contentBytes, 'base64') });
        }
      }
    }
    return {
      providerMessageId: m.id,
      internetMessageId: m.internetMessageId ?? null,
      conversationId: m.conversationId ?? null,
      inReplyTo: header('in-reply-to'),
      references: String(header('references') ?? '')
        .split(/\s+/)
        .filter(Boolean),
      from: m.from?.emailAddress?.address?.toLowerCase() ?? null,
      to: (m.toRecipients ?? []).map((r: any) => r.emailAddress.address.toLowerCase()),
      cc: (m.ccRecipients ?? []).map((r: any) => r.emailAddress.address.toLowerCase()),
      subject: m.subject ?? '',
      text: m.body?.content ?? '',
      receivedAt: new Date(m.receivedDateTime ?? Date.now()),
      attachments,
    };
  }
}

export const CONNECTORS = () => [
  { provider: 'microsoft' as const, available: graphAvailable(), reason: graphAvailable() ? undefined : 'not_configured' },
  // Prioritised one fully functional connector. Gmail is intentionally not offered yet.
  { provider: 'google' as const, available: false, reason: 'not_available_in_this_release' },
];
