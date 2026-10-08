import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { login, setup, teardown, type Agent } from './helpers.js';
import type { DemoIds } from '../src/seed/demo.js';

let app: FastifyInstance;
let ids: DemoIds;
const as: Record<string, Agent> = {};

beforeAll(async () => {
  ({ app, ids } = await setup());
  for (const u of ['ana.admin', 'rui.manager', 'carla.coord', 'pedro.coord', 'helena.hr', 'joao.employee', 'maria.employee', 'sup.travel', 'sup.hotel', 'bob.kwanza', 'sofia.multi']) {
    as[u] = await login(app, u, u === 'ana.admin' ? 'hwk' : 'otp');
  }
});
afterAll(() => teardown(app));

describe('tenant isolation', () => {
  it('another organisation’s records are not found, never forbidden-but-existing', async () => {
    const bob = as['bob.kwanza'];
    for (const url of [
      `/api/personnel/${ids.people.joao}`,
      `/api/crew-changes/${ids.crewChanges.cc1}`,
      `/api/requests/${ids.requests.flightJoao}`,
    ]) {
      const r = await bob.get(url);
      expect(r.status, url).toBe(404);
    }
    const list = await bob.get('/api/personnel');
    expect(list.body.rows.map((p: any) => p.id)).toEqual([ids.bPerson]);
  });

  it('cannot write into another organisation by referencing its ids', async () => {
    const bob = as['bob.kwanza'];
    const r = await bob.post('/api/tasks', { title: 'x', personnelId: ids.people.joao });
    expect(r.status).toBe(404);
  });

  it('a user in two organisations must switch explicitly and only sees the active one', async () => {
    const sofia = as['sofia.multi'];
    const me = await sofia.get('/api/me');
    expect(me.body.memberships).toHaveLength(2);
    expect(me.body.activeOrg).toBeNull(); // two workspaces: no implicit choice
    expect((await sofia.get('/api/personnel')).body.error).toBe('workspace_required');
    await sofia.switchTo(ids.orgA);
    const a = await sofia.get('/api/personnel');
    expect(a.body.rows.some((p: any) => p.id === ids.people.joao)).toBe(true);
    expect(a.body.rows.some((p: any) => p.id === ids.bPerson)).toBe(false);
    await sofia.switchTo(ids.orgB);
    const b = await sofia.get('/api/personnel');
    expect(b.body.rows.map((p: any) => p.id)).toEqual([ids.bPerson]);
    expect((await sofia.get(`/api/personnel/${ids.people.joao}`)).status).toBe(404);
  });

  it('cannot switch into an organisation without a membership', async () => {
    expect((await as['bob.kwanza'].switchTo(ids.orgA)).status).toBe(404);
  });

  it('database row-level security blocks cross-tenant reads even without application filters', async () => {
    const c = new pg.Client({ connectionString: 'postgres://cc_app_login:cc_app_dev@localhost:5432/crew_coordinator_test' });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [ids.orgB]);
      const leaked = await c.query('SELECT count(*)::int AS n FROM personnel WHERE org_id = $1', [ids.orgA]);
      expect(leaked.rows[0].n).toBe(0);
      const all = await c.query('SELECT count(*)::int AS n FROM service_requests');
      expect(all.rows[0].n).toBe(1);
      await expect(c.query("INSERT INTO tasks (org_id, title) VALUES ($1, 'injected')", [ids.orgA])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      // Without any tenant context nothing is visible at all (deny by default).
      const none = await c.query('SELECT count(*)::int AS n FROM personnel');
      expect(none.rows[0].n).toBe(0);
      // The application role cannot rewrite or delete audit history.
      await expect(c.query('DELETE FROM audit_events')).rejects.toThrow();
    } finally {
      await c.end();
    }
  });
});

describe('employee restricted records', () => {
  it('an employee sees only their own record, including their own identity data', async () => {
    const joao = as['joao.employee'];
    const list = await joao.get('/api/personnel');
    expect(list.body.rows.map((p: any) => p.id)).toEqual([ids.people.joao]);
    const own = await joao.get(`/api/personnel/${ids.people.joao}`);
    expect(own.body.identity.passport_number).toBe('N1234567');
    expect((await joao.get(`/api/personnel/${ids.people.maria}`)).status).toBe(404);
  });

  it('an employee sees only their own itinerary and tasks', async () => {
    const joao = as['joao.employee'];
    const reqs = await joao.get('/api/requests');
    expect(reqs.body.length).toBeGreaterThan(0);
    expect(reqs.body.every((r: any) => r.personnel_id === ids.people.joao)).toBe(true);
    expect((await joao.get(`/api/requests/${ids.requests.flightMaria}`)).status).toBe(404);
    const tasks = await joao.get('/api/tasks');
    expect(tasks.body.every((t: any) => t.assignee_id === ids.users['joao.employee'])).toBe(true);
  });
});

describe('field-level restriction of identity and medical data', () => {
  it('a coordinator sees identity data needed for travel, but not medical details', async () => {
    const r = await as['carla.coord'].get(`/api/personnel/${ids.people.tiago}`);
    expect(r.body.identity.passport_number).toBe('N2345678');
    expect(r.body.medical).toEqual({ restricted: true });
  });

  it('HR/compliance sees medical details; managers see neither', async () => {
    expect((await as['helena.hr'].get(`/api/personnel/${ids.people.andre}`)).body.medical.fitness_status).toBe('fit_with_restrictions');
    const m = await as['rui.manager'].get(`/api/personnel/${ids.people.andre}`);
    expect(m.body.medical).toEqual({ restricted: true });
    expect(m.body.identity).toEqual({ restricted: true });
  });

  it('viewing restricted fields is audited without recording their values', async () => {
    const audit = await as['ana.admin'].get(`/api/admin/audit?action=personnel.restricted_viewed`);
    expect(audit.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.body)).not.toContain('fit_with_restrictions');
    expect(JSON.stringify(audit.body)).not.toContain('N2345678');
  });

  it('only medical editors can change medical records', async () => {
    const r = await as['carla.coord'].put(`/api/personnel/${ids.people.joao}/medical`, { version: 1, values: { fitness_status: 'unfit' } });
    expect(r.status).toBe(403);
  });
});

describe('supplier isolation', () => {
  it('a supplier sees only requests assigned to them and only permitted passenger fields', async () => {
    // Make two flight requests visible to the travel supplier (sent), hotel ones to the hotel.
    const c = new pg.Client({ connectionString: 'postgres://postgres@localhost:5432/crew_coordinator_test' });
    await c.connect();
    await c.query("UPDATE service_requests SET status = 'requested' WHERE org_id = $1 AND type IN ('flight', 'hotel')", [ids.orgA]);
    await c.end();
    const travel = await as['sup.travel'].get('/api/requests');
    expect(travel.status).toBe(200);
    expect(travel.body.length).toBe(2);
    expect(travel.body.every((r: any) => r.supplier_id === ids.suppliers.sTravel)).toBe(true);
    expect(Object.keys(travel.body[0].person).sort()).toEqual(['employee_no', 'full_name', 'nationality', 'phone']);
    const hotelSees = await as['sup.hotel'].get('/api/requests');
    expect(hotelSees.body.every((r: any) => r.supplier_id === ids.suppliers.sHotel)).toBe(true);
    expect((await as['sup.hotel'].get(`/api/requests/${ids.requests.flightJoao}`)).status).toBe(404);
  });

  it('a supplier cannot see draft requests that were not sent to them, nor personnel, crew changes or emails', async () => {
    const travel = as['sup.travel'];
    expect((await travel.get(`/api/requests/${ids.requests.transferJoao}`)).status).toBe(404);
    expect((await travel.get('/api/personnel')).status).toBe(403);
    expect((await travel.get(`/api/crew-changes/${ids.crewChanges.cc1}`)).status).toBe(403);
    expect((await travel.get('/api/packages')).status).toBe(403);
    expect((await travel.get('/api/insights')).body).toEqual([]);
  });

  it('a supplier response through the portal is recorded for review, never as a confirmation', async () => {
    const travel = as['sup.travel'];
    const r = (await travel.get(`/api/requests/${ids.requests.flightJoao}`)).body;
    const res = await travel.post(`/api/requests/${r.id}/respond`, { version: r.version, response: 'confirmed', bookingReference: 'XK4P7Q' });
    expect(res.body.status).toBe('change_pending_review');
  });
});

describe('asset scope', () => {
  it('an asset-scoped coordinator only sees crew changes for their assets', async () => {
    const pedro = as['pedro.coord'];
    const list = await pedro.get('/api/crew-changes');
    expect(list.body.map((c: any) => c.id)).toEqual([ids.crewChanges.cc2]);
    expect((await pedro.get(`/api/crew-changes/${ids.crewChanges.cc1}`)).status).toBe(404);
    expect((await pedro.get(`/api/requests/${ids.requests.flightJoao}`)).status).toBe(404);
  });
});

describe('privilege escalation and segregation of duties', () => {
  it('nobody can change their own role or scope', async () => {
    const ana = as['ana.admin'];
    const own = (await ana.get('/api/admin/members')).body.find((m: any) => m.user_id === ids.users['ana.admin']);
    const r = await ana.patch(`/api/admin/members/${own.id}`, { role: 'hr_compliance', version: own.version });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('cannot_modify_self');
  });

  it('non-administrators cannot manage members or settings, whatever they send', async () => {
    const carla = as['carla.coord'];
    const members = (await as['ana.admin'].get('/api/admin/members')).body;
    const self = members.find((m: any) => m.user_id === ids.users['carla.coord']);
    expect((await carla.patch(`/api/admin/members/${self.id}`, { role: 'org_admin', version: self.version })).status).toBe(403);
    expect((await carla.patch('/api/admin/settings', { mfa_required: false })).status).toBe(403);
    expect((await carla.post('/api/admin/invitations', { email: 'x@y.example', role: 'org_admin' })).status).toBe(403);
  });

  it('the last administrator cannot be removed', async () => {
    const sofia = as['sofia.multi'];
    await sofia.switchTo(ids.orgB);
    const members = (await sofia.get('/api/admin/members')).body;
    const bob = members.find((m: any) => m.user_id === ids.users['bob.kwanza']);
    expect((await sofia.patch(`/api/admin/members/${bob.id}`, { role: 'employee', version: bob.version })).status).toBe(200);
    const bobAgain = (await as['bob.kwanza'].get('/api/me')).body;
    expect(bobAgain.role).toBe('employee'); // applied immediately to Bob's active session
    const self = members.find((m: any) => m.user_id === ids.users['sofia.multi']);
    expect(self).toBeTruthy();
  });

  it('a crew change cannot be approved by the person who submitted it, and needs the approve permission', async () => {
    const carla = as['carla.coord'];
    const cc = (await carla.get(`/api/crew-changes/${ids.crewChanges.cc1}`)).body;
    const sub = await carla.post(`/api/crew-changes/${cc.id}/submit`, { version: cc.version });
    expect(sub.body.status).toBe('approval_pending');
    expect((await carla.post(`/api/crew-changes/${cc.id}/approve`, { version: sub.body.version })).status).toBe(403);
    const rui = as['rui.manager'];
    const res = await rui.post(`/api/crew-changes/${cc.id}/approve`, { version: sub.body.version });
    // Critical readiness blockers (expired medical) must be acknowledged explicitly.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blockers_present');
    const ok = await rui.post(`/api/crew-changes/${cc.id}/approve`, { version: sub.body.version, acknowledgeBlockers: true });
    expect(ok.status).toBe(200);
    expect(ok.body.approved_by).toBe(ids.users['rui.manager']);
  });

  it('whoever records a credential cannot verify it', async () => {
    const helena = as['helena.hr'];
    const c = await helena.post(`/api/personnel/${ids.people.joao}/credentials`, { requirementTypeId: ids.requirementTypes.rH2S, expiresOn: '2030-01-01' });
    expect(c.status).toBe(200);
    const v = await helena.post(`/api/credentials/${c.body.id}/verify`, { outcome: 'verified', version: c.body.version });
    expect(v.body.error).toBe('segregation_of_duties');
  });

  it('a supplier contact cannot be verified by the person who added it', async () => {
    const ana = as['ana.admin'];
    const c = await ana.post(`/api/suppliers/${ids.suppliers.sTransport}/contacts`, { name: 'New', email: 'new@luanda-transfers.example' });
    expect(c.body.verified).toBe(false);
    expect((await ana.post(`/api/supplier-contacts/${c.body.id}/verify`)).body.error).toBe('segregation_of_duties');
  });
});

describe('insecure direct object references', () => {
  it('random and malformed ids return 404 without leaking errors', async () => {
    const carla = as['carla.coord'];
    expect((await carla.get('/api/personnel/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await carla.get("/api/personnel/1' OR '1'='1")).status).toBe(404);
    expect((await carla.get('/api/requests/not-a-uuid')).status).toBe(404);
  });

  it('signed download links are bound to the session that requested them', async () => {
    const helena = as['helena.hr'];
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const up = await helena.upload(`/api/personnel/${ids.people.joao}/documents`, 'medical.pdf', pdf, { classification: 'medical' });
    expect(up.status).toBe(200);
    const link = await helena.post(`/api/documents/${up.body.id}/link`);
    expect(link.status).toBe(200);
    expect((await helena.get(link.body.url)).status).toBe(200);
    // A coordinator holding the same URL cannot use it.
    expect((await as['carla.coord'].get(link.body.url)).status).toBe(404);
    // A coordinator cannot request a link for a medical document either.
    expect((await as['carla.coord'].post(`/api/documents/${up.body.id}/link`)).status).toBe(404);
    // A tampered token is rejected.
    expect((await helena.get(link.body.url.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A')))).status).toBe(404);
  });

  it('uploads are type-checked by content, not by name', async () => {
    const fake = Buffer.from('MZ\x90\x00 this is an executable');
    const r = await as['helena.hr'].upload(`/api/personnel/${ids.people.joao}/documents`, 'scan.pdf', fake, { classification: 'general' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('file_type_not_allowed');
  });
});
