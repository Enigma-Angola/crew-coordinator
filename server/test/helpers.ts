import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { buildDevIdp } from '../src/devidp/server.js';
import { DEV_USERS, seedDemo, type DemoIds } from '../src/seed/demo.js';
import { closePool, withTx } from '../src/db/pool.js';
import { refreshInsights } from '../src/domain/insights.js';
import { stopListening } from '../src/realtime/events.js';
import { clearIdpCache } from '../src/auth/oidc.js';

export const OWNER_URL = 'postgres://postgres@localhost:5432/crew_coordinator_test';

let idp: FastifyInstance | null = null;

export async function startIdp() {
  if (idp) return;
  idp = await buildDevIdp({
    issuer: 'http://localhost:4501',
    users: DEV_USERS.map((u) => ({ sub: u.sub, email: u.email, email_verified: !u.unverified, name: u.name })),
    clients: [{ clientId: 'crew-coordinator', clientSecret: 'test-secret', redirectUris: ['http://app.test/auth/callback'] }],
  });
  await idp.listen({ port: 4501, host: '127.0.0.1' });
}

export async function setup(): Promise<{ app: FastifyInstance; ids: DemoIds }> {
  await startIdp();
  clearIdpCache();
  const ids = await seedDemo(OWNER_URL, { reset: true });
  for (const org of [ids.orgA, ids.orgB]) await withTx({ orgId: org }, (db) => refreshInsights(db, org));
  const app = await buildApp();
  return { app, ids };
}

export async function teardown(app?: FastifyInstance) {
  await app?.close();
  await idp?.close();
  idp = null;
  await stopListening();
  await closePool();
}

export class Agent {
  constructor(public app: FastifyInstance, public cookie: string, public csrf: string) {}

  async req(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { cookie: this.cookie, ...extraHeaders };
    if (method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const res = await this.app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* binary or empty */
    }
    return { status: res.statusCode, body: json, raw: res };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
  patch = (url: string, body: unknown) => this.req('PATCH', url, body);
  put = (url: string, body: unknown) => this.req('PUT', url, body);
  del = (url: string) => this.req('DELETE', url);

  async upload(url: string, filename: string, content: Buffer, fields: Record<string, string> = {}) {
    const boundary = `----cc${randomUUID()}`;
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`));
    const res = await this.app.inject({
      method: 'POST',
      url,
      headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
    return { status: res.statusCode, body: res.json() };
  }

  async switchTo(orgId: string) {
    return this.post('/api/me/workspace', { orgId });
  }
}

/** Drives the real OIDC authorization-code + PKCE flow against the test IdP. */
let ipCounter = 0;
export async function oidcRoundTrip(app: FastifyInstance, sub: string, method: 'pwd' | 'otp' | 'hwk', query = '', cookie = '', ip?: string) {
  // Each simulated browser gets its own address so the per-IP sign-in rate limit is not shared.
  const remoteAddress = ip ?? `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  const start = await app.inject({ method: 'GET', url: `/auth/login?idp=dev${query}`, remoteAddress, headers: cookie ? { cookie } : {} });
  if (start.statusCode !== 302) throw Object.assign(new Error(`login start failed ${start.statusCode}`), { statusCode: start.statusCode });
  const authUrl = new URL(start.headers.location as string);
  const form = new URLSearchParams({ ...Object.fromEntries(authUrl.searchParams), sub, method });
  const done = await fetch('http://localhost:4501/authorize/complete', { method: 'POST', body: form, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cb = new URL(done.headers.get('location')!);
  return app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, remoteAddress, headers: cookie ? { cookie } : {} });
}

export async function login(app: FastifyInstance, sub: string, method: 'pwd' | 'otp' | 'hwk' = 'otp', query = '') {
  const res = await oidcRoundTrip(app, sub, method, query);
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error(`login for ${sub} failed: ${res.headers.location}`);
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return new Agent(app, cookie, me.json().csrfToken);
}

/* Fake Microsoft Graph + identity platform -------------------------------------------------- */

export interface FakeGraph {
  app: FastifyInstance;
  sent: any[];
  inbox: any[];
  mode: { send: 'ok' | 'error_502_after_accept' | 'error_400' | 'throttle' };
  addInbound(m: { subject: string; from: string; body: string; inReplyTo?: string; references?: string[]; conversationId?: string; attachments?: { name: string; contentType: string; content: Buffer }[] }): string;
}

export async function startFakeGraph(): Promise<FakeGraph> {
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, b, d) => d(null, Object.fromEntries(new URLSearchParams(b as string))));
  const state: FakeGraph = {
    app,
    sent: [],
    inbox: [],
    mode: { send: 'ok' },
    addInbound(m) {
      const id = `in-${randomUUID()}`;
      state.inbox.push({
        id,
        internetMessageId: `<${id}@supplier.example>`,
        conversationId: m.conversationId ?? `conv-${randomUUID()}`,
        subject: m.subject,
        from: { emailAddress: { address: m.from } },
        toRecipients: [{ emailAddress: { address: 'crew.ops@atlantica.example' } }],
        ccRecipients: [],
        receivedDateTime: new Date().toISOString(),
        body: { contentType: 'text', content: m.body },
        internetMessageHeaders: [
          ...(m.inReplyTo ? [{ name: 'In-Reply-To', value: m.inReplyTo }] : []),
          ...(m.references ? [{ name: 'References', value: m.references.join(' ') }] : []),
        ],
        hasAttachments: !!m.attachments?.length,
        attachments: (m.attachments ?? []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: a.content.toString('base64') })),
        delivered: false,
      });
      return id;
    },
  };
  app.post('/organizations/oauth2/v2.0/token', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.client_id !== 'graph-client' || b.client_secret !== 'graph-secret') return reply.code(401).send({ error: 'invalid_client' });
    if (b.grant_type === 'refresh_token' && b.refresh_token === 'revoked') return reply.code(400).send({ error: 'invalid_grant' });
    return { access_token: `at-${randomUUID()}`, refresh_token: 'rt-1', expires_in: 3600, scope: 'offline_access User.Read Mail.Read Mail.Send' };
  });
  app.get('/v1.0/me', async () => ({ mail: 'crew.ops@atlantica.example' }));
  app.post('/v1.0/me/sendMail', async (req, reply) => {
    if (state.mode.send === 'throttle') return reply.code(429).header('retry-after', '1').send({ error: { code: 'TooManyRequests' } });
    if (state.mode.send === 'error_400') return reply.code(400).send({ error: { code: 'ErrorInvalidRecipients' } });
    const m = (req.body as any).message;
    const key = m.singleValueExtendedProperties?.[0]?.value;
    const id = `sent-${state.sent.length + 1}`;
    state.sent.push({ id, key, internetMessageId: `<${id}@atlantica.example>`, conversationId: `conv-${id}`, message: m, sentDateTime: new Date().toISOString() });
    if (state.mode.send === 'error_502_after_accept') {
      state.mode.send = 'ok';
      return reply.code(502).send({ error: { code: 'BadGateway' } });
    }
    return reply.code(202).send();
  });
  app.get('/v1.0/me/mailFolders/sentitems/messages', async (req) => {
    const filter = String((req.query as any).$filter ?? '');
    const key = filter.match(/ep\/value eq '([^']+)'/)?.[1];
    const m = state.sent.find((s) => s.key === key);
    return { value: m ? [{ id: m.id, internetMessageId: m.internetMessageId, conversationId: m.conversationId, sentDateTime: m.sentDateTime }] : [] };
  });
  app.get('/v1.0/me/mailFolders/:folder/messages/delta', async (req) => {
    const fresh = state.inbox.filter((m) => !m.delivered);
    fresh.forEach((m) => (m.delivered = true));
    return { value: fresh.map((m) => ({ id: m.id })), '@odata.deltaLink': `http://localhost:4510/v1.0/me/mailFolders/${(req.params as any).folder}/messages/delta?token=${Date.now()}` };
  });
  app.get('/v1.0/me/messages/:id', async (req, reply) => {
    const m = state.inbox.find((x) => x.id === (req.params as any).id);
    if (!m) return reply.code(404).send();
    const { attachments: _a, delivered: _d, ...rest } = m;
    return rest;
  });
  app.get('/v1.0/me/messages/:id/attachments', async (req) => ({ value: state.inbox.find((x) => x.id === (req.params as any).id)?.attachments ?? [] }));
  await app.listen({ port: 4510, host: '127.0.0.1' });
  return state;
}

/* Fake Anthropic Messages API --------------------------------------------------------------- */

export async function startFakeAnthropic() {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024 });
  const requests: any[] = [];
  app.post('/v1/messages', async (req) => {
    requests.push(req.body);
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: (req.body as any).model,
      content: [{ type: 'text', text: 'Summary based on the provided records.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 8 },
    };
  });
  await app.listen({ port: 4520, host: '127.0.0.1' });
  return { app, requests };
}
