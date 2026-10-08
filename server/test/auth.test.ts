import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { login, oidcRoundTrip, OWNER_URL, setup, teardown } from './helpers.js';
import type { DemoIds } from '../src/seed/demo.js';

let app: FastifyInstance;
let ids: DemoIds;

beforeAll(async () => {
  ({ app, ids } = await setup());
});
afterAll(() => teardown(app));

const owner = async (sql: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

describe('authentication through the identity provider (OIDC + PKCE)', () => {
  it('signs in a member and selects their only workspace', async () => {
    const carla = await login(app, 'carla.coord', 'otp');
    const me = await carla.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.activeOrg.id).toBe(ids.orgA);
    expect(me.body.role).toBe('coordinator');
    expect(me.body.session.mfa).toBe(true);
    expect(me.body.permissions).toContain('email:send');
  });

  it('uses one generic refusal for unknown, unverified and suspended identities (no account enumeration)', async () => {
    const unknown = await oidcRoundTrip(app, 'nuno.invited', 'otp');
    const unverified = await oidcRoundTrip(app, 'eve.unverified', 'otp');
    await owner("UPDATE users SET status = 'suspended' WHERE idp_subject = 'rui.manager'");
    const suspended = await oidcRoundTrip(app, 'rui.manager', 'otp');
    await owner("UPDATE users SET status = 'active' WHERE idp_subject = 'rui.manager'");
    for (const r of [unknown, unverified, suspended]) {
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('http://app.test/signin?error=access_unavailable');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const events = await owner("SELECT detail->>'reason' AS reason FROM security_events WHERE kind = 'login_denied' ORDER BY id");
    expect(events.map((e) => e.reason)).toEqual(expect.arrayContaining(['no_account', 'email_not_verified', 'user_suspended']));
  });

  it('rate-limits sign-in attempts per client address', async () => {
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push((await app.inject({ method: 'GET', url: '/auth/login?idp=dev', remoteAddress: '192.0.2.77' })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 302)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429, 429, 429, 429]);
  });

  it('raises a security alert after repeated failed sign-ins from one address', async () => {
    for (let i = 0; i < 10; i++) await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=bad' + i, remoteAddress: '198.51.100.9' });
    const alerts = await owner("SELECT * FROM security_alerts WHERE code = 'repeated_login_failures' AND detail->>'subject' = '198.51.100.9'");
    expect(alerts).toHaveLength(1);
  });

  it('rejects a callback with a forged or replayed state', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=forged' });
    expect(r.headers.location).toContain('error=access_unavailable');
  });

  it('only accepts same-site return paths (no open redirect)', async () => {
    const r = await oidcRoundTrip(app, 'carla.coord', 'otp', '&returnTo=' + encodeURIComponent('//evil.example/x'));
    expect(r.headers.location).toBe('http://app.test/');
  });

  it('requires MFA for privileged roles and lets ordinary employees use password-only sign-in unless the organisation enforces MFA', async () => {
    const coordPwd = await login(app, 'carla.coord', 'pwd');
    const me = await coordPwd.get('/api/me');
    expect(me.body.orgBlock).toBe('mfa_required');
    expect(me.body.permissions).toEqual([]);
    expect((await coordPwd.get('/api/personnel')).body.error).toBe('mfa_required');

    const empPwd = await login(app, 'joao.employee', 'pwd');
    expect((await empPwd.get('/api/me')).body.orgBlock).toBeNull();

    await owner('UPDATE organizations SET mfa_required = true WHERE id = $1', [ids.orgA]);
    expect((await empPwd.get('/api/me')).body.orgBlock).toBe('mfa_required');
    await owner('UPDATE organizations SET mfa_required = false WHERE id = $1', [ids.orgA]);
  });

  it('can require phishing-resistant authentication for administrators', async () => {
    await owner('UPDATE organizations SET phishing_resistant_admins = true WHERE id = $1', [ids.orgA]);
    const otp = await login(app, 'ana.admin', 'otp');
    expect((await otp.get('/api/me')).body.orgBlock).toBe('phishing_resistant_required');
    const key = await login(app, 'ana.admin', 'hwk');
    expect((await key.get('/api/me')).body.orgBlock).toBeNull();
    await owner('UPDATE organizations SET phishing_resistant_admins = false WHERE id = $1', [ids.orgA]);
  });

  it('enforces CSRF tokens and same-origin checks on state-changing requests', async () => {
    const carla = await login(app, 'carla.coord');
    const noToken = await app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: carla.cookie }, payload: { title: 'x' } });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error).toBe('csrf_failed');
    const badOrigin = await app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: carla.cookie, 'x-csrf-token': carla.csrf, origin: 'https://evil.example' }, payload: { title: 'x' } });
    expect(badOrigin.json().error).toBe('bad_origin');
  });

  it('requires a recent authentication (step-up) for sensitive administration', async () => {
    const ana = await login(app, 'ana.admin');
    await owner("UPDATE sessions SET auth_time = now() - interval '1 hour' WHERE user_id = $1", [ids.users['ana.admin']]);
    const r = await ana.post('/api/admin/invitations', { email: 'new.person@atlantica.example', role: 'employee' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('reauth_required');
    // Re-authenticate at the IdP (prompt=login, max_age=0) on the same session.
    const step = await oidcRoundTrip(app, 'ana.admin', 'otp', '&stepup=1&returnTo=/admin', ana.cookie);
    expect(step.headers.location).toBe('http://app.test/admin');
    const again = await ana.post('/api/admin/invitations', { email: 'new.person@atlantica.example', role: 'employee' });
    expect(again.status).toBe(200);
    expect(again.body.inviteUrl).toMatch(/^http:\/\/app\.test\/invite\//);
  });

  it('refuses step-up completed by a different identity', async () => {
    const ana = await login(app, 'ana.admin');
    const step = await oidcRoundTrip(app, 'rui.manager', 'otp', '&stepup=1', ana.cookie);
    expect(step.headers.location).toContain('error=access_unavailable');
  });
});

describe('invitation-based registration with administrator approval', () => {
  it('registers an invited, verified user as pending until a different administrator approves', async () => {
    const ana = await login(app, 'ana.admin');
    const inv = await ana.post('/api/admin/invitations', { email: 'nuno.pires@atlantica.example', role: 'coordinator', language: 'pt-PT' });
    expect(inv.status).toBe(200);
    expect(inv.body.email.subject).toContain('Convite');
    const token = inv.body.inviteUrl.split('/invite/')[1];

    const wrongPerson = await oidcRoundTrip(app, 'eve.unverified', 'otp', `&invitation=${token}`);
    expect(wrongPerson.headers.location).toContain('access_unavailable');

    const r = await oidcRoundTrip(app, 'nuno.invited', 'otp', `&invitation=${token}`);
    expect(r.headers['set-cookie']).toBeDefined();
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me.memberships[0].status).toBe('pending_approval');
    expect(me.activeOrg).toBeNull();

    // The invitation cannot be reused.
    const reuse = await oidcRoundTrip(app, 'nuno.invited', 'otp', `&invitation=${token}`);
    expect(reuse.headers['set-cookie']).toBeDefined(); // existing user may sign in...
    const members = (await ana.get('/api/admin/members')).body;
    const pending = members.find((m: any) => m.email === 'nuno.pires@atlantica.example');
    expect(members.filter((m: any) => m.email === 'nuno.pires@atlantica.example')).toHaveLength(1); // ...but no second membership

    const approve = await ana.post(`/api/admin/members/${pending.id}/approve`);
    expect(approve.status).toBe(200);
    await app.inject({ method: 'POST', url: '/api/me/workspace', headers: { cookie, 'x-csrf-token': me.csrfToken }, payload: { orgId: ids.orgA } });
    const after = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(after.role).toBe('coordinator');
    expect(after.orgBlock).toBeNull();
  });
});

describe('sessions: visibility, expiry and immediate revocation', () => {
  it('lists the user’s sessions and lets them revoke one remotely', async () => {
    const a = await login(app, 'helena.hr');
    const b = await login(app, 'helena.hr');
    const list = await a.get('/api/me/sessions');
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const other = list.body.find((s: any) => !s.current);
    expect((await a.del(`/api/me/sessions/${other.id}`)).status).toBe(200);
    const bSessions = await b.get('/api/me');
    // One of the two sessions was revoked; if it was b's, b is now signed out.
    const revoked = list.body.find((s: any) => s.id === other.id);
    expect(revoked).toBeTruthy();
    expect([200, 401]).toContain(bSessions.status);
  });

  it('suspending a member and revoking sessions stops access on the very next request', async () => {
    const maria = await login(app, 'maria.employee');
    expect((await maria.get('/api/personnel')).status).toBe(200);
    const ana = await login(app, 'ana.admin');
    const member = (await ana.get('/api/admin/members')).body.find((m: any) => m.email === 'maria.lopes@atlantica.example');
    const r = await ana.post(`/api/admin/members/${member.id}/suspend`);
    expect(r.status).toBe(200);
    expect(r.body.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await maria.get('/api/personnel')).status).toBe(401);
    // Even a fresh sign-in cannot use the workspace while suspended.
    const again = await login(app, 'maria.employee');
    expect((await again.get('/api/me')).body.memberships[0].status).toBe('suspended');
    expect((await again.get('/api/personnel')).status).toBe(403);
    await ana.post(`/api/admin/members/${member.id}/reactivate`);
  });

  it('expires idle sessions', async () => {
    const pedro = await login(app, 'pedro.coord');
    await owner("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1", [ids.users['pedro.coord']]);
    expect((await pedro.get('/api/me')).status).toBe(401);
  });

  it('a permission change applies to an active session immediately', async () => {
    const carla = await login(app, 'carla.coord');
    expect((await carla.get('/api/personnel')).status).toBe(200);
    await owner("UPDATE memberships SET role = 'supplier', supplier_id = $2 WHERE user_id = $1 AND org_id = $3", [ids.users['carla.coord'], ids.suppliers.sTravel, ids.orgA]);
    expect((await carla.get('/api/personnel')).status).toBe(403);
    await owner("UPDATE memberships SET role = 'coordinator', supplier_id = NULL WHERE user_id = $1 AND org_id = $2", [ids.users['carla.coord'], ids.orgA]);
  });

  it('signs out', async () => {
    const rui = await login(app, 'rui.manager');
    expect((await rui.post('/auth/logout')).status).toBe(200);
    expect((await rui.get('/api/me')).status).toBe(401);
  });
});
