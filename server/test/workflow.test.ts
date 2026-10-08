/**
 * OPERATIONAL ACCEPTANCE TEST
 *
 * Roster import → crew change → provider-specific XLSX attachments → separate travel,
 * hotel, transport and medical emails → review → send through a connected mailbox →
 * supplier reply with an altered arrangement → association → extraction and review →
 * update of approved records → downstream impact → complete email and attachment history.
 *
 * The mailbox is a local fake of Microsoft Graph implementing the endpoints the connector
 * uses. It verifies our behaviour against the documented API contract; it is NOT evidence of
 * a live Microsoft 365 integration (see docs/ACCEPTANCE.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { login, OWNER_URL, setup, startFakeGraph, teardown, type Agent, type FakeGraph } from './helpers.js';
import type { DemoIds } from '../src/seed/demo.js';
import { processOutbox, processReminders } from '../src/email/packages.js';

let app: FastifyInstance;
let ids: DemoIds;
let graph: FakeGraph;
let carla: Agent, rui: Agent, ana: Agent, pedro: Agent;
const state: Record<string, any> = {};

const day = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const eu = (iso: string) => iso.split('-').reverse().join('/');
const owner = async (sql: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  ({ app, ids } = await setup());
  graph = await startFakeGraph();
  carla = await login(app, 'carla.coord');
  rui = await login(app, 'rui.manager');
  ana = await login(app, 'ana.admin');
  pedro = await login(app, 'pedro.coord');
});
afterAll(async () => {
  await graph.app.close();
  await teardown(app);
});

describe('operational acceptance workflow', () => {
  it('1. imports a crew roster with a validated preview before committing', async () => {
    const csv = [
      'Employee number;Nome;Função;Nacionalidade;Telefone;Unidade;Início;Fim',
      `AT-1012;Nádia Tavares;Production Operator;Angolana;+244 923 000 012;KN;${eu(day(5))};${eu(day(33))}`,
      `AT-1001;João Silva;Production Operator;Angolana;+244 923 111 001;;;`,
      `;Sem número;Operator;;;;;`,
      `AT-1013;Bad Asset;Operator;;;ZZ;${eu(day(5))};${eu(day(33))}`,
    ].join('\n');
    const preview = await carla.upload('/api/personnel/import?dryRun=1', 'roster.csv', Buffer.from(csv));
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.summary).toMatchObject({ total: 4, create: 1, update: 1, errors: 2 });
    expect(preview.body.rows.find((r: any) => r.row === 4).errors).toContain('missing_employee_no');
    expect(preview.body.rows.find((r: any) => r.employeeNo === 'AT-1013').errors).toContain('unknown_asset');
    expect((await carla.get('/api/personnel?q=Nádia')).body.total).toBe(0); // nothing written yet

    const commit = await carla.upload('/api/personnel/import?dryRun=0', 'roster.csv', Buffer.from(csv));
    expect(commit.body.summary.create).toBe(1);
    const nadia = (await carla.get('/api/personnel?q=Nádia')).body.rows[0];
    expect(nadia.employee_no).toBe('AT-1012');
    state.nadia = nadia.id;
    const detail = (await carla.get(`/api/personnel/${nadia.id}`)).body;
    expect(detail.assignments).toHaveLength(1);
  });

  it('2. selects the upcoming crew change and adds the new crew member with a draft flight', async () => {
    const cc = (await carla.get(`/api/crew-changes/${ids.crewChanges.cc1}`)).body;
    expect(cc.people.filter((p: any) => p.direction === 'on')).toHaveLength(3);
    expect((await carla.post(`/api/crew-changes/${cc.id}/people`, { personnelId: state.nadia, direction: 'on' })).status).toBe(200);
    const gen = await carla.post(`/api/crew-changes/${cc.id}/requests/generate`, { types: ['flight'], suppliers: { flight: ids.suppliers.sTravel } });
    // Nádia and Tiago lacked flight requests; existing requests are not duplicated.
    expect(gen.body.created).toBe(2);
    state.nadiaFlight = gen.body.requests.find((r: any) => r.personnel_id === state.nadia);
    state.tiagoFlight = gen.body.requests.find((r: any) => r.personnel_id === ids.people.tiago);
  });

  it('3. generates provider-specific packages: separate travel, hotel, transport and medical emails', async () => {
    const r = await carla.post('/api/packages/prepare', { crewChangeId: ids.crewChanges.cc1 });
    expect(r.status).toBe(200);
    const pk = r.body.packages;
    expect(pk).toHaveLength(4);
    const list = (await carla.get(`/api/packages?crewChangeId=${ids.crewChanges.cc1}`)).body;
    const by = (name: string) => list.find((p: any) => p.supplier_name === name);
    state.pkg = { travel: by('TransAfrica Travel'), hotel: by('Hotel Presidente Luanda'), transport: by('Luanda Transfers'), medical: by('Clínica Esperança') };
    expect(Object.values(state.pkg).every(Boolean)).toBe(true);
    expect(state.pkg.travel.request_count).toBe(4);
    expect(state.pkg.hotel.request_count).toBe(3);
    // Training for the other crew change is not mixed in.
    expect(list.some((p: any) => p.supplier_name === 'Offshore Safety Academy')).toBe(false);
  });

  it('4. shows everything needed for review, with missing information blocking the travel package', async () => {
    const travel = (await carla.get(`/api/packages/${state.pkg.travel.id}`)).body;
    expect(travel.demonstrationMode).toBe(true); // no mailbox connected yet
    expect(travel.to_addresses).toEqual(['bookings@transafrica-travel.example']);
    expect(travel.cc_addresses).toEqual(['account.manager@transafrica-travel.example']);
    expect(travel.subject).toContain(travel.reference);
    expect(travel.language).toBe('en');
    expect(travel.requests.map((r: any) => r.full_name).sort()).toEqual(['João Silva', 'Maria Lopes', 'Nádia Tavares', 'Tiago Nunes']);
    expect(travel.blocking).toBe(true);
    expect(travel.warnings.filter((w: any) => w.code === 'missing_field').map((w: any) => w.field)).toEqual(
      expect.arrayContaining(['details.from', 'details.depart_local:date']),
    );
    expect(travel.attachments).toHaveLength(1);
    expect(travel.attachments[0].filename).toMatch(/^FlightRequest_CC-\d{4}-0001_/);

    const transport = (await carla.get(`/api/packages/${state.pkg.transport.id}`)).body;
    // The unverified contact at the transport company is never used.
    expect(transport.cc_addresses).not.toContain('random@luanda-transfers.example');
    expect(transport.language).toBe('pt-PT');
    expect(transport.body_text).toContain('manifesto de transporte');

    const approve = await rui.post(`/api/packages/${travel.id}/approve`, { version: travel.version });
    expect(approve.body.error).toBe('package_has_blocking_warnings');
  });

  it('5. fixing the record and regenerating produces a new attachment while keeping the superseded one', async () => {
    const d4 = day(4);
    for (const f of [state.nadiaFlight, state.tiagoFlight]) {
      const r = (await carla.get(`/api/requests/${f.id}`)).body;
      const fix = await carla.patch(`/api/requests/${r.id}`, { version: r.version, changes: { 'details.from': 'LIS', 'details.to': 'LAD', 'details.depart_local': `${d4}T08:15`, 'details.arrive_local': `${d4}T15:40` } });
      expect(fix.status).toBe(200);
    }
    // Approving stale content is impossible: the package must be regenerated first.
    const regen = await carla.post(`/api/packages/${state.pkg.travel.id}/regenerate`);
    expect(regen.body.blocking).toBe(false);
    const travel = (await carla.get(`/api/packages/${state.pkg.travel.id}`)).body;
    expect(travel.attachments).toHaveLength(2);
    expect(travel.attachments.filter((a: any) => a.superseded_at)).toHaveLength(1);
    state.travelAttachment = travel.attachments.find((a: any) => !a.superseded_at);
  });

  it('6. review: the preparer cannot approve their own package; a reviewer can', async () => {
    for (const k of ['travel', 'hotel', 'transport', 'medical']) {
      const p = (await carla.get(`/api/packages/${state.pkg[k].id}`)).body;
      expect((await carla.post(`/api/packages/${p.id}/approve`, { version: p.version })).body.error).toBe('segregation_of_duties');
      const ok = await rui.post(`/api/packages/${p.id}/approve`, { version: p.version });
      expect(ok.status, k).toBe(200);
    }
  });

  it('7. without a connected mailbox: clearly labelled demonstration download, and no simulated sending', async () => {
    const p = (await carla.get(`/api/packages/${state.pkg.medical.id}`)).body;
    const send = await carla.post(`/api/packages/${p.id}/send`, { version: p.version });
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('no_connected_mailbox');
    expect((await carla.get(`/api/packages/${p.id}`)).body.status).toBe('approved');
    const links = (await carla.post(`/api/packages/${p.id}/links`)).body;
    const eml = await carla.get(links.eml);
    expect(eml.status).toBe(200);
    const text = eml.raw.body;
    expect(text).toContain('X-CrewCoord-Demonstration: not sent by Crew Coordinator');
    expect(text).toContain('Marcacoes_CC-');
    const att = await carla.get(links.attachments[0].url);
    expect(att.raw.headers['content-type']).toContain('spreadsheetml');
    // Links expire and are bound to the session.
    expect((await pedro.get(links.eml)).status).toBe(404);
  });

  it('8. connects a Microsoft 365 mailbox through OAuth (no password), with least-privilege scopes', async () => {
    const start = await ana.post('/api/mailboxes/connect', { provider: 'microsoft', kind: 'individual' });
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe('offline_access User.Read Mail.Read Mail.Send');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const google = await ana.post('/api/mailboxes/connect', { provider: 'google' });
    expect(google.body.error).toBe('connector_not_available');
    const cb = await ana.get(`/api/mailboxes/oauth/callback?code=fake-code&state=${url.searchParams.get('state')}`);
    expect(cb.raw.headers.location).toBe('http://app.test/settings/mailboxes?connected=1');
    const boxes = (await ana.get('/api/mailboxes')).body;
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ provider: 'microsoft', address: 'crew.ops@atlantica.example', status: 'connected' });
    state.mailbox = boxes[0];
    const stored = await owner('SELECT token_ciphertext FROM mailbox_connections WHERE id = $1', [boxes[0].id]);
    expect(stored[0].token_ciphertext.toString('latin1')).not.toContain('rt-1'); // tokens encrypted at rest
  });

  it('9. sends the travel email with the generated attachment through the connected mailbox', async () => {
    const p = (await carla.get(`/api/packages/${state.pkg.travel.id}`)).body;
    const r = await carla.post(`/api/packages/${p.id}/send`, { version: p.version });
    expect(r.body).toMatchObject({ attempt: 'submitted' });
    expect(r.status).toBe(200);
    expect(r.body.attempt).toBe('submitted');
    expect(graph.sent).toHaveLength(1);
    const m = graph.sent[0].message;
    expect(m.toRecipients.map((x: any) => x.emailAddress.address)).toEqual(['bookings@transafrica-travel.example']);
    expect(m.attachments[0].name).toBe(state.travelAttachment.filename);
    const sentXlsx = Buffer.from(m.attachments[0].contentBytes, 'base64');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(sentXlsx as any);
    const ws = wb.worksheets[0];
    const names: string[] = [];
    ws.eachRow((row) => names.push(String(row.getCell(2).value)));
    expect(names).toEqual(expect.arrayContaining(['João Silva', 'Maria Lopes', 'Nádia Tavares', 'Tiago Nunes']));
    state.sentWorkbook = sentXlsx;
    const after = (await carla.get(`/api/packages/${p.id}`)).body;
    expect(after.status).toBe('submitted');
    expect(after.internet_message_id).toBe(graph.sent[0].internetMessageId);
    const req = (await carla.get(`/api/requests/${ids.requests.flightJoao}`)).body;
    expect(req.status).toBe('requested');
  });

  it('10. an uncertain send outcome is reconciled against Sent Items without sending a duplicate', async () => {
    graph.mode.send = 'error_502_after_accept';
    const p = (await carla.get(`/api/packages/${state.pkg.hotel.id}`)).body;
    const r = await carla.post(`/api/packages/${p.id}/send`, { version: p.version });
    expect(r.body.attempt).toBe('uncertain');
    expect((await carla.get(`/api/packages/${p.id}`)).body.status).toBe('send_uncertain');
    expect(graph.sent).toHaveLength(2);
    const results = await processOutbox(ids.orgA);
    expect(results.find((x) => x.id === p.id)?.outcome).toBe('reconciled_submitted');
    expect(graph.sent).toHaveLength(2); // not re-sent
    expect((await carla.get(`/api/packages/${p.id}`)).body.status).toBe('submitted');
  });

  it('11. a definite provider rejection is reported as failed, not as sent', async () => {
    graph.mode.send = 'error_400';
    const p = (await carla.get(`/api/packages/${state.pkg.transport.id}`)).body;
    const r = await carla.post(`/api/packages/${p.id}/send`, { version: p.version });
    expect(r.body.attempt).toBe('failed');
    const after = (await carla.get(`/api/packages/${p.id}`)).body;
    expect(after.status).toBe('send_failed');
    expect(after.last_send_error).toBe('ErrorInvalidRecipients');
    graph.mode.send = 'ok';
    // A failed package can be regenerated, reviewed again and resent.
    await carla.post(`/api/packages/${p.id}/regenerate`);
    const again = (await carla.get(`/api/packages/${p.id}`)).body;
    await rui.post(`/api/packages/${p.id}/approve`, { version: again.version });
    const v = (await carla.get(`/api/packages/${p.id}`)).body.version;
    expect((await carla.post(`/api/packages/${p.id}/send`, { version: v })).body.attempt).toBe('submitted');
    const med = (await carla.get(`/api/packages/${state.pkg.medical.id}`)).body;
    expect((await carla.post(`/api/packages/${med.id}/send`, { version: med.version })).body.attempt).toBe('submitted');
  });

  it('12. synchronises only relevant messages and associates the supplier reply by thread, not by name', async () => {
    const d4 = day(4);
    const travelSent = graph.sent[0];
    const refs = (await carla.get(`/api/packages/${state.pkg.travel.id}`)).body.requests;
    const joaoRef = refs.find((r: any) => r.full_name === 'João Silva').reference;
    const mariaRef = refs.find((r: any) => r.full_name === 'Maria Lopes').reference;
    state.joaoRef = joaoRef;

    // The supplier edits the spreadsheet we sent: fills a PNR for Nádia and moves João by a day.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(state.sentWorkbook);
    const ws = wb.worksheets[0];
    ws.eachRow((row) => {
      if (row.getCell(2).value === 'Nádia Tavares') row.getCell(10).value = 'NT9Q2W';
      if (row.getCell(2).value === 'João Silva') row.getCell(7).value = new Date(`${day(5)}T00:00:00Z`);
    });
    const returned = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    graph.addInbound({
      subject: `RE: ${travelSent.message.subject}`,
      from: 'bookings@transafrica-travel.example',
      inReplyTo: travelSent.internetMessageId,
      references: [travelSent.internetMessageId],
      body: `Dear Carla,\n\nPlease note:\n${joaoRef} João Silva: flight changed and confirmed, DT654 LIS-LAD ${eu(d4)} 10:30 17:55, PNR XK4P7Q\n${mariaRef} Maria Lopes: confirmed as requested, PNR AB12CD\n\nRegards\nTransAfrica\n\nOn Mon, 12 Oct 2026 at 09:00, Crew Ops <crew.ops@atlantica.example> wrote:\n> Please book. Booking confirmed?`,
      attachments: [{ name: 'FlightRequest_returned.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: returned }],
    });
    // Duplicate delivery of the same message must not create a second record.
    const dupId = graph.inbox[graph.inbox.length - 1].internetMessageId;
    graph.addInbound({ subject: 'dup', from: 'bookings@transafrica-travel.example', body: 'dup' });
    graph.inbox[graph.inbox.length - 1].internetMessageId = dupId;
    // Personal or unrelated mail is never imported.
    graph.addInbound({ subject: 'Lunch on Friday?', from: 'friend@personal.example', body: 'See you at 13:00' });
    // The hotel only acknowledges.
    const hotelSent = graph.sent[1];
    graph.addInbound({ subject: `RE: ${hotelSent.message.subject}`, from: 'reservas@hotel-presidente.example', inReplyTo: hotelSent.internetMessageId, body: 'Bom dia,\n\nBem recebido, vamos tratar.\n\nCumprimentos' });

    const sync = await carla.post(`/api/mailboxes/${state.mailbox.id}/sync`);
    expect(sync.body.status).toBe('ok');
    expect(sync.body.seen).toBe(4);
    expect(sync.body.stored).toBe(2);
    const stored = await owner('SELECT subject, match_status, match_method FROM email_messages WHERE direction = $1 ORDER BY received_at', ['inbound']);
    expect(stored.map((s) => s.subject)).not.toContain('Lunch on Friday?');
    expect(stored.every((s) => s.match_status === 'matched' && s.match_method === 'thread_headers')).toBe(true);

    const joaoReq = (await carla.get(`/api/requests/${ids.requests.flightJoao}`)).body;
    expect(joaoReq.messages.some((m: any) => m.direction === 'inbound')).toBe(true);
    // The body names João and Maria only; Nádia is linked solely because her row changed in
    // the returned spreadsheet. Tiago is not linked at all.
    const nadiaReq = (await carla.get(`/api/requests/${state.nadiaFlight.id}`)).body;
    expect(nadiaReq.messages.filter((m: any) => m.direction === 'inbound').map((m: any) => m.method)).toEqual(['returned_workbook']);
    expect(nadiaReq.proposals).toHaveLength(0);
    const tiagoReq = (await carla.get(`/api/requests/${state.tiagoFlight.id}`)).body;
    expect(tiagoReq.messages.filter((m: any) => m.direction === 'inbound')).toHaveLength(0);
  });

  it('13. extracts proposed changes alongside their source, keeping acknowledgement, confirmation and modification distinct', async () => {
    const proposals = (await carla.get('/api/proposals')).body;
    const joao = proposals.find((p: any) => p.request_id === ids.requests.flightJoao);
    const maria = proposals.find((p: any) => p.request_id === ids.requests.flightMaria);
    const hotel = proposals.filter((p: any) => p.type === 'hotel');
    expect(joao.classification).toBe('modification');
    expect(joao.fields.alsoConfirms).toBe(true);
    const f = Object.fromEntries(joao.fields.items.map((i: any) => [i.field, i]));
    expect(f['details.depart_local'].current).toBe(`${day(4)}T08:15`);
    expect(f['details.depart_local'].proposed).toBe(`${day(4)}T10:30`);
    expect(f['details.depart_local'].source.excerpt).toContain('DT654');
    expect(f.booking_reference.proposed).toBe('XK4P7Q');
    expect(maria.classification).toBe('confirmed');
    expect(hotel.length).toBe(3);
    expect(hotel.every((h: any) => h.classification === 'acknowledgement')).toBe(true);
    // A "received" message cannot be used to record a confirmation.
    const reqH = (await carla.get(`/api/requests/${hotel[0].request_id}`)).body;
    const bad = await carla.post(`/api/proposals/${hotel[0].id}/apply`, { fields: [], resultingStatus: 'confirmed', version: reqH.version });
    expect(bad.body.error).toBe('not_a_confirmation');
    // Business status is unchanged until a person validates.
    expect(reqH.status).toBe('requested');
    expect(reqH.first_response_at).toBeTruthy();
    state.joaoProposal = joao;
  });

  it('14. a person validates and applies the change; the record and timeline are updated', async () => {
    const req = (await carla.get(`/api/requests/${ids.requests.flightJoao}`)).body;
    const r = await carla.post(`/api/proposals/${state.joaoProposal.id}/apply`, {
      fields: ['details.flight_no', 'details.depart_local', 'details.arrive_local', 'booking_reference'],
      resultingStatus: 'confirmed',
      version: req.version,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('confirmed');
    expect(r.body.details).toMatchObject({ flight_no: 'DT654', depart_local: `${day(4)}T10:30`, arrive_local: `${day(4)}T17:55` });
    expect(r.body.booking_reference).toBe('XK4P7Q');
    const tl = (await carla.get(`/api/requests/${ids.requests.flightJoao}/timeline`)).body;
    const reached = tl.stages.filter((s: any) => s.reachedAt).map((s: any) => s.stage);
    expect(reached).toEqual(['draft_prepared', 'reviewed', 'queued', 'submitted', 'response_received', 'confirmation_recorded']);
    expect(tl.technical).toEqual([{ status: 'submitted', channel: 'connector' }]);
    expect(JSON.stringify(tl)).not.toMatch(/delivered|read_receipt/);
  });

  it('15. flags downstream impacts on the hotel and transfer bookings', async () => {
    const insights = (await carla.get(`/api/insights?crewChangeId=${ids.crewChanges.cc1}`)).body;
    const impact = insights.find((i: any) => i.code === 'flight_change_impact' && i.request_id === ids.requests.flightJoao);
    expect(impact).toBeTruthy();
    expect(impact.kind).toBe('rule_warning');
    const deps = impact.supporting.filter((s: any) => s.role === 'dependent').map((s: any) => s.id).sort();
    expect(deps).toEqual([ids.requests.hotelJoao, ids.requests.transferJoao].sort());
    expect(impact.actions[0].code).toBe('prepare_amendment');
    const misaligned = insights.find((i: any) => i.code === 'transfer_before_arrival' && i.request_id === ids.requests.transferJoao);
    expect(misaligned.params.pickupLocal).toBe(`${day(4)}T16:30`);
    // Suggested actions are never applied automatically.
    const transfer = (await carla.get(`/api/requests/${ids.requests.transferJoao}`)).body;
    expect(transfer.details.pickup_local).toBe(`${day(4)}T16:30`);
    // An amendment email can be prepared for review on request.
    const am = await carla.post('/api/packages/prepare', { requestIds: [ids.requests.transferJoao], purpose: 'amendment' });
    expect(am.body.packages).toHaveLength(1);
    const pkg = (await carla.get(`/api/packages/${am.body.packages[0].id}`)).body;
    expect(pkg.subject.startsWith('ALTERAÇÃO')).toBe(true);
    expect(pkg.status).toBe('in_review');
  });

  it('16. reconciles the returned spreadsheet against what was sent and current records', async () => {
    const recs = await owner('SELECT id FROM workbook_reconciliations');
    expect(recs).toHaveLength(1);
    const res = (await carla.get(`/api/reconciliations/${recs[0].id}`)).body.result;
    expect(res.originalAttachmentId).toBe(state.travelAttachment.id);
    const nadia = res.rows.find((r: any) => r.requestId === state.nadiaFlight.id);
    expect(nadia.status).toBe('changed');
    expect(nadia.changes).toEqual([expect.objectContaining({ key: 'request.booking_reference', sent: null, returned: 'NT9Q2W' })]);
    // Trusted structured source + pure booking-reference fill-in → narrow automatic update.
    expect(nadia.autoApplied).toBe(true);
    expect((await carla.get(`/api/requests/${state.nadiaFlight.id}`)).body.booking_reference).toBe('NT9Q2W');
    const joao = res.rows.find((r: any) => r.requestId === ids.requests.flightJoao);
    const dateChange = joao.changes.find((c: any) => c.key === 'details.depart_local');
    expect(dateChange.returned).toBe(`${day(5)}T08:15`);
    // The flight changed in our records after sending (10:30), so this is a conflict.
    expect(joao.status).toBe('conflict');
    expect(dateChange.conflict).toBe(true);
    const unchanged = res.rows.find((r: any) => r.requestId === ids.requests.flightMaria);
    expect(unchanged.status).toBe('unchanged');

    const j = (await carla.get(`/api/requests/${ids.requests.flightJoao}`)).body;
    const silent = await carla.post(`/api/reconciliations/${recs[0].id}/apply`, { selections: [{ requestId: j.id, version: j.version, keys: ['details.depart_local'] }] });
    expect(silent.body.error).toBe('conflict_resolution_required');
    expect((await carla.get(`/api/requests/${ids.requests.flightJoao}`)).body.details.depart_local).toBe(`${day(4)}T10:30`);
    expect((await carla.post(`/api/reconciliations/${recs[0].id}/reject`)).status).toBe(200);
  });

  it('17. preserves the exact sent attachment and its source snapshot, unaffected by later record changes', async () => {
    const att = await owner('SELECT * FROM attachments WHERE id = $1', [state.travelAttachment.id]);
    const snap = att[0].source_snapshot.rows.find((r: any) => r['request.id'] === ids.requests.flightJoao);
    expect(snap['details.depart_local']).toBe(`${day(4)}T08:15`); // as sent, not as now
    await expect(owner("UPDATE attachments SET sha256 = 'tampered' WHERE id = $1", [state.travelAttachment.id])).rejects.toThrow(/immutable/);
    await expect(owner('DELETE FROM attachments WHERE id = $1', [state.travelAttachment.id])).rejects.toThrow();
    const link = await carla.post(`/api/attachments/${state.travelAttachment.id}/link`);
    const file = await carla.get(link.body.url);
    expect(Buffer.compare(file.raw.rawPayload, state.sentWorkbook)).toBe(0);
    const history = (await carla.get(`/api/packages/${state.pkg.travel.id}`)).body;
    expect(history.messages.map((m: any) => m.direction)).toEqual(['outbound', 'inbound']);
  });

  it('18. tracks response deadlines: prepares reminders when nobody replied, stops them when a reply arrived', async () => {
    await owner("UPDATE reminders SET due_at = now() - interval '1 minute' WHERE status = 'scheduled'");
    await processReminders(ids.orgA);
    const rem = await owner("SELECT r.status, r.reason, p.reference, p.supplier_id FROM reminders r JOIN email_packages p ON p.id = r.package_id WHERE r.reason IN ('response_deadline', 'response_received')");
    const bySupplier = (s: string) => rem.filter((r) => r.supplier_id === s);
    expect(bySupplier(ids.suppliers.sHotel).every((r) => r.status === 'cancelled')).toBe(true); // all acknowledged
    expect(bySupplier(ids.suppliers.sMedical).some((r) => r.status === 'prepared')).toBe(true);
    // Travel: João and Maria replied in the body, Nádia via the returned spreadsheet; only Tiago is chased.
    const travelReminder = await owner(
      `SELECT r.reference FROM email_packages p JOIN package_requests pr ON pr.package_id = p.id JOIN service_requests r ON r.id = pr.request_id
       WHERE p.purpose = 'reminder' AND p.supplier_id = $1`,
      [ids.suppliers.sTravel],
    );
    expect(travelReminder.map((r) => r.reference)).toEqual([state.tiagoFlight.reference]);
    const reminders = (await carla.get('/api/packages?status=in_review')).body.filter((p: any) => p.purpose === 'reminder');
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders.every((p: any) => p.status === 'in_review')).toBe(true); // drafted for review, not sent
    expect(reminders.some((p: any) => p.subject.startsWith('LEMBRETE'))).toBe(true);
  });

  it('19. low-confidence messages go to the unmatched queue for manual association', async () => {
    graph.addInbound({ subject: 'Question about next week', from: 'operacoes@luanda-transfers.example', body: 'Can you confirm how many people for Thursday?' });
    graph.addInbound({ subject: `Re: ${state.joaoRef}`, from: 'stranger@unknown.example', body: `${state.joaoRef} cancelled.` });
    await carla.post(`/api/mailboxes/${state.mailbox.id}/sync`);
    const queue = (await carla.get('/api/messages?status=unmatched')).body;
    const transfers = queue.find((m: any) => m.from_address === 'operacoes@luanda-transfers.example');
    expect(transfers).toBeTruthy();
    expect(transfers.match_candidates.length).toBeGreaterThan(0);
    // A reference typed by an unknown sender is not trusted automatically.
    const stranger = queue.find((m: any) => m.from_address === 'stranger@unknown.example');
    expect(stranger.warnings).toContain('sender_not_verified_supplier_contact');
    expect((await carla.get(`/api/requests/${ids.requests.flightJoao}`)).body.status).toBe('confirmed');
    // Asset-scoped colleagues do not see the organisation-wide unmatched queue.
    expect((await pedro.get('/api/messages?status=unmatched')).body).toEqual([]);
    const link = await carla.post(`/api/messages/${transfers.id}/link`, { requestIds: [ids.requests.transferJoao] });
    expect(link.status).toBe(200);
    expect((await carla.get(`/api/messages/${transfers.id}`)).body.match_status).toBe('matched');
  });

  it('20. expired mailbox authorisation is detected and reported for reconnection', async () => {
    const [box] = await owner('SELECT id FROM mailbox_connections');
    const { sealTokens } = await import('../src/email/connectors/graph.js');
    await owner('UPDATE mailbox_connections SET token_ciphertext = $2 WHERE id = $1', [box.id, sealTokens(box.id, { access_token: 'x', refresh_token: 'revoked', expires_at: 0 })]);
    const r = await carla.post(`/api/mailboxes/${box.id}/sync`);
    expect(r.body.status).toBe('reauthorisation_required');
    expect((await carla.get('/api/mailboxes')).body[0].status).toBe('reauthorisation_required');
  });
});
