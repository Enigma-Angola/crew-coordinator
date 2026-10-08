import pg from 'pg';
import { randomUUID } from 'node:crypto';

/**
 * Demonstration dataset. Clearly fictional: organisations, people and suppliers are invented
 * and all email addresses use reserved example domains. Dates are relative to "today" so the
 * demonstration stays current. Runs with the owner connection (bypasses RLS) by design.
 */
export const DEV_USERS = [
  { sub: 'ana.admin', email: 'ana.ferreira@atlantica.example', name: 'Ana Ferreira', lang: 'pt-PT' },
  { sub: 'rui.manager', email: 'rui.costa@atlantica.example', name: 'Rui Costa', lang: 'pt-PT' },
  { sub: 'carla.coord', email: 'carla.mendes@atlantica.example', name: 'Carla Mendes', lang: 'pt-PT' },
  { sub: 'pedro.coord', email: 'pedro.santos@atlantica.example', name: 'Pedro Santos', lang: 'en' },
  { sub: 'helena.hr', email: 'helena.rocha@atlantica.example', name: 'Helena Rocha', lang: 'pt-PT' },
  { sub: 'joao.employee', email: 'joao.silva@atlantica.example', name: 'João Silva', lang: 'pt-PT' },
  { sub: 'maria.employee', email: 'maria.lopes@atlantica.example', name: 'Maria Lopes', lang: 'en' },
  { sub: 'sup.travel', email: 'bookings@transafrica-travel.example', name: 'TransAfrica Travel (portal)', lang: 'en' },
  { sub: 'sup.hotel', email: 'reservas@hotel-presidente.example', name: 'Hotel Presidente (portal)', lang: 'pt-PT' },
  { sub: 'sofia.multi', email: 'sofia.almeida@consult.example', name: 'Sofia Almeida', lang: 'en' },
  { sub: 'bob.kwanza', email: 'bob.martins@kwanza.example', name: 'Bob Martins', lang: 'en' },
  { sub: 'nuno.invited', email: 'nuno.pires@atlantica.example', name: 'Nuno Pires', lang: 'pt-PT' },
  { sub: 'eve.unverified', email: 'eve@unverified.example', name: 'Eve Unverified', lang: 'en', unverified: true },
];

const day = (n: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function seedDemo(connectionString: string, opts: { reset?: boolean } = {}) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
  try {
    await c.query('BEGIN');
    if (opts.reset) {
      // Test/demo reset only. Audit rows are append-only by trigger, so the owner disables
      // the trigger for this administrative wipe of a non-production database.
      await c.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await c.query('ALTER TABLE attachments DISABLE TRIGGER USER');
      const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")).map((r) => r.tablename);
      await c.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
      await c.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
      await c.query('ALTER TABLE attachments ENABLE TRIGGER USER');
    }

    const orgA = await one(
      "INSERT INTO organizations (slug, name, default_language, default_timezone, default_currency, mfa_required) VALUES ('atlantica', 'Atlântica Offshore Services (demo)', 'pt-PT', 'Africa/Luanda', 'AOA', false) RETURNING id",
    );
    const orgB = await one(
      "INSERT INTO organizations (slug, name, default_language, default_timezone, default_currency) VALUES ('kwanza', 'Kwanza Marine Logistics (demo)', 'en', 'Africa/Luanda', 'USD') RETURNING id",
    );

    const users: Record<string, string> = {};
    for (const u of DEV_USERS) {
      const r = await one('INSERT INTO users (idp, idp_subject, email, email_verified, display_name, language) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [
        'dev',
        u.sub,
        u.email,
        !u.unverified,
        u.name,
        u.lang,
      ]);
      users[u.sub] = r.id;
    }
    // Nobody is "registered" without an invitation: Nuno and Eve exist at the IdP only.
    await c.query('DELETE FROM users WHERE idp_subject IN ($1, $2)', ['nuno.invited', 'eve.unverified']);
    delete users['nuno.invited'];
    delete users['eve.unverified'];

    const sup = async (org: string, name: string, category: string, lang: string, trusted = false) =>
      (await one('INSERT INTO suppliers (org_id, name, category, default_language, trusted_structured_updates) VALUES ($1,$2,$3,$4,$5) RETURNING id', [org, name, category, lang, trusted])).id;
    const sTravel = await sup(orgA.id, 'TransAfrica Travel', 'travel', 'en', true);
    const sHotel = await sup(orgA.id, 'Hotel Presidente Luanda', 'hotel', 'pt-PT');
    const sTransport = await sup(orgA.id, 'Luanda Transfers', 'transport', 'pt-PT');
    const sMedical = await sup(orgA.id, 'Clínica Esperança', 'medical', 'pt-PT');
    const sTraining = await sup(orgA.id, 'Offshore Safety Academy', 'training', 'en');
    const sBTravel = await sup(orgB.id, 'Kwanza Travel Desk', 'travel', 'en');

    const member = async (org: string, user: string, role: string, extra: { supplier?: string; scope?: string[] } = {}) =>
      c.query("INSERT INTO memberships (org_id, user_id, role, status, supplier_id, asset_scope, approved_by, approved_at) VALUES ($1,$2,$3,'active',$4,$5,$6, now())", [
        org,
        user,
        role,
        extra.supplier ?? null,
        extra.scope ?? null,
        users['ana.admin'],
      ]);

    const asset = async (org: string, code: string, name: string, kind: string) =>
      (await one("INSERT INTO assets (org_id, code, name, kind, timezone, location) VALUES ($1,$2,$3,$4,'Africa/Luanda','Bloco 32, Angola') RETURNING id", [org, code, name, kind])).id;
    const aKN = await asset(orgA.id, 'KN', 'FPSO Kaombo Norte', 'vessel');
    const aLB = await asset(orgA.id, 'LB', 'Drillship Lobito Star', 'rig');
    const aB1 = await asset(orgB.id, 'KS1', 'Kwanza Supply 1', 'vessel');

    await member(orgA.id, users['ana.admin'], 'org_admin');
    await member(orgA.id, users['rui.manager'], 'manager');
    await member(orgA.id, users['carla.coord'], 'coordinator');
    await member(orgA.id, users['pedro.coord'], 'coordinator', { scope: [aLB] });
    await member(orgA.id, users['helena.hr'], 'hr_compliance');
    await member(orgA.id, users['joao.employee'], 'employee');
    await member(orgA.id, users['maria.employee'], 'employee');
    await member(orgA.id, users['sup.travel'], 'supplier', { supplier: sTravel });
    await member(orgA.id, users['sup.hotel'], 'supplier', { supplier: sHotel });
    await member(orgA.id, users['sofia.multi'], 'coordinator');
    await member(orgB.id, users['sofia.multi'], 'org_admin');
    await member(orgB.id, users['bob.kwanza'], 'org_admin');

    const rt = async (org: string, code: string, en: string, pt: string, category: string) =>
      (await one('INSERT INTO requirement_types (org_id, code, name_en, name_pt, category) VALUES ($1,$2,$3,$4,$5) RETURNING id', [org, code, en, pt, category])).id;
    const rBOSIET = await rt(orgA.id, 'BOSIET', 'Basic offshore safety induction', 'Indução básica de segurança offshore', 'training');
    const rHUET = await rt(orgA.id, 'HUET', 'Helicopter underwater escape', 'Fuga subaquática de helicóptero', 'training');
    const rMED = await rt(orgA.id, 'MED-OFF', 'Offshore medical certificate', 'Certificado médico offshore', 'medical');
    const rH2S = await rt(orgA.id, 'H2S', 'H2S awareness', 'Sensibilização H2S', 'certificate');
    const rPASS = await rt(orgA.id, 'PASSPORT', 'Valid passport', 'Passaporte válido', 'identity');

    const pos = async (asset: string, title: string, headcount: number, reqs: string[]) =>
      (await one('INSERT INTO positions (org_id, asset_id, title, headcount, requirement_ids) VALUES ((SELECT org_id FROM assets WHERE id = $1),$1,$2,$3,$4) RETURNING id', [asset, title, headcount, reqs])).id;
    const pProd = await pos(aKN, 'Production Operator', 2, [rBOSIET, rHUET, rMED]);
    const pCRO = await pos(aKN, 'Control Room Operator', 1, [rBOSIET, rHUET, rMED]);
    const pDriller = await pos(aLB, 'Driller', 1, [rBOSIET, rH2S, rMED]);
    const pMedic = await pos(aLB, 'Offshore Medic', 1, [rBOSIET, rHUET, rMED]);

    const people: Record<string, string> = {};
    const person = async (key: string, no: string, name: string, title: string, nat: string, userKey?: string, status = 'active') => {
      const r = await one(
        `INSERT INTO personnel (org_id, employee_no, full_name, email, phone, nationality, job_title, home_base, employer, user_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Luanda','Atlântica Offshore Services',$8,$9) RETURNING id`,
        [orgA.id, no, name, `${key}@atlantica.example`, `+244 9${no.slice(-2)}0 000 ${no.slice(-3)}`, nat, title, userKey ? users[userKey] : null, status],
      );
      people[key] = r.id;
      return r.id;
    };
    await person('joao', 'AT-1001', 'João Silva', 'Production Operator', 'Angolana', 'joao.employee');
    await person('maria', 'AT-1002', 'Maria Lopes', 'Production Operator', 'Portuguesa', 'maria.employee');
    await person('tiago', 'AT-1003', 'Tiago Nunes', 'Control Room Operator', 'Angolana');
    await person('ines', 'AT-1004', 'Inês Carvalho', 'Production Operator', 'Angolana');
    await person('miguel', 'AT-1005', 'Miguel Duarte', 'Control Room Operator', 'Portuguesa');
    await person('paulo', 'AT-1006', 'Paulo Domingos', 'Driller', 'Angolana');
    await person('luisa', 'AT-1007', 'Luísa Baptista', 'Offshore Medic', 'Brasileira');
    await person('andre', 'AT-1008', 'André Gomes', 'Driller', 'Angolana');
    await person('beatriz', 'AT-1009', 'Beatriz Fonseca', 'Production Operator', 'Angolana');
    await person('kevin', 'AT-1010', 'Kevin Okafor', 'Offshore Medic', 'Nigerian');
    await person('rosa', 'AT-1011', 'Rosa Quintas', 'Production Operator', 'Angolana', undefined, 'onboarding');
    const bPerson = await one("INSERT INTO personnel (org_id, employee_no, full_name, job_title, nationality) VALUES ($1,'KM-0001','Samuel Kiala','Deckhand','Angolana') RETURNING id", [orgB.id]);

    // Credentials: mostly valid, with deliberate exceptions the insights engine should find.
    const cred = async (p: string, r: string, expires: string | null, status = 'verified') =>
      c.query('INSERT INTO credentials (org_id, personnel_id, requirement_type_id, issued_on, expires_on, verification_status, verified_by, verified_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        orgA.id,
        people[p],
        r,
        day(-300),
        expires,
        status,
        status === 'verified' ? users['helena.hr'] : null,
        status === 'verified' ? new Date() : null,
        users['carla.coord'],
      ]);
    for (const p of Object.keys(people)) {
      if (p === 'rosa') continue;
      await cred(p, rBOSIET, day(400));
      await cred(p, rHUET, day(350));
      await cred(p, rMED, day(200));
      await cred(p, rH2S, day(500));
      await cred(p, rPASS, day(900));
    }
    // Maria's HUET expires during her next rotation; Tiago's medical expires before it; Inês has a pending BOSIET renewal.
    await c.query('UPDATE credentials SET expires_on = $3 WHERE personnel_id = $1 AND requirement_type_id = $2', [people.maria, rHUET, day(15)]);
    await c.query('UPDATE credentials SET expires_on = $3 WHERE personnel_id = $1 AND requirement_type_id = $2', [people.tiago, rMED, day(2)]);
    await cred('ines', rBOSIET, day(700), 'pending');
    await cred('rosa', rBOSIET, day(600), 'pending');

    const med = async (p: string, status: string) =>
      c.query("INSERT INTO personnel_medical (personnel_id, org_id, fitness_status, examined_on, expires_on, provider_name) VALUES ($1,$2,$3,$4,$5,'Clínica Esperança')", [people[p], orgA.id, status, day(-100), day(200)]);
    for (const p of ['joao', 'maria', 'tiago', 'ines', 'miguel', 'paulo', 'luisa', 'beatriz', 'kevin']) await med(p, 'fit');
    await med('andre', 'fit_with_restrictions');
    const idn = async (p: string, passport: string, expiry: string, dob: string) =>
      c.query('INSERT INTO personnel_identity (personnel_id, org_id, passport_number, passport_country, passport_expiry, date_of_birth) VALUES ($1,$2,$3,$4,$5,$6)', [people[p], orgA.id, passport, 'AO', expiry, dob]);
    await idn('joao', 'N1234567', day(1200), '1988-04-12');
    await idn('maria', 'P7654321', day(800), '1991-09-30');
    await idn('tiago', 'N2345678', day(60), '1985-01-17');
    await idn('ines', 'N3456789', day(1500), '1993-06-05');

    // Rotations (28 on / 28 off) and the crew change bringing the next shift aboard.
    const asg = async (p: string | null, asset: string, position: string, from: number, to: number) =>
      (await one('INSERT INTO assignments (org_id, personnel_id, asset_id, position_id, starts_on, ends_on, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [
        orgA.id,
        p ? people[p] : null,
        asset,
        position,
        day(from),
        day(to),
        from <= 0 ? 'in_progress' : 'planned',
      ])).id;
    await asg('ines', aKN, pProd, -23, 5);
    await asg('beatriz', aKN, pProd, -23, 5);
    await asg('miguel', aKN, pCRO, -23, 5);
    const asgJoao = await asg('joao', aKN, pProd, 5, 33);
    const asgMaria = await asg('maria', aKN, pProd, 5, 33);
    const asgTiago = await asg('tiago', aKN, pCRO, 5, 33);
    await asg('paulo', aLB, pDriller, -10, 18);
    await asg('luisa', aLB, pMedic, -10, 18);
    await asg('andre', aLB, pDriller, 18, 46);
    const gap = await asg(null, aLB, pMedic, 18, 46); // uncovered medic slot

    const cc1 = await one(
      `INSERT INTO crew_changes (org_id, reference, asset_id, scheduled_on, embarkation_point, embarkation_at, status, created_by, updated_by)
       VALUES ($1, 'CC-${new Date().getUTCFullYear()}-0001', $2, $3, 'Heliporto do Aeroporto 4 de Fevereiro', ($3::date + time '07:30') AT TIME ZONE 'Africa/Luanda', 'planning', $4, $4) RETURNING id`,
      [orgA.id, aKN, day(5), users['carla.coord']],
    );
    const cc2 = await one(
      `INSERT INTO crew_changes (org_id, reference, asset_id, scheduled_on, embarkation_point, status, created_by, updated_by)
       VALUES ($1, 'CC-${new Date().getUTCFullYear()}-0002', $2, $3, 'Base do Soyo', 'planning', $4, $4) RETURNING id`,
      [orgA.id, aLB, day(18), users['pedro.coord']],
    );
    await c.query('UPDATE assignments SET crew_change_on_id = $1 WHERE id = ANY($2::uuid[])', [cc1.id, [asgJoao, asgMaria, asgTiago]]);
    for (const [p, dir, a] of [['joao', 'on', asgJoao], ['maria', 'on', asgMaria], ['tiago', 'on', asgTiago], ['ines', 'off', null], ['beatriz', 'off', null]] as const) {
      await c.query('INSERT INTO crew_change_people (org_id, crew_change_id, personnel_id, direction, assignment_id) VALUES ($1,$2,$3,$4,$5)', [orgA.id, cc1.id, people[p], dir, a]);
    }
    await c.query("INSERT INTO crew_change_people (org_id, crew_change_id, personnel_id, direction) VALUES ($1,$2,$3,'on')", [orgA.id, cc2.id, people.andre]);
    await c.query("INSERT INTO crew_change_people (org_id, crew_change_id, personnel_id, direction) VALUES ($1,$2,$3,'off')", [orgA.id, cc2.id, people.paulo]);

    // Draft requests for crew change 1 (ready to be packaged into emails).
    const year = new Date().getUTCFullYear();
    let n = 0;
    const req = async (p: string, type: string, supplier: string, details: Record<string, string>, starts: string | null, cc = cc1.id) => {
      n++;
      return (await one(
        `INSERT INTO service_requests (org_id, reference, crew_change_id, personnel_id, supplier_id, type, details, location_tz, starts_at, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Africa/Luanda',$8,$9,$9) RETURNING id`,
        [orgA.id, `REQ-${year}-${String(n).padStart(4, '0')}`, cc, people[p], supplier, type, details, starts, users['carla.coord']],
      )).id;
    };
    const d4 = day(4);
    const requests: Record<string, string> = {};
    requests.flightJoao = await req('joao', 'flight', sTravel, { from: 'LIS', to: 'LAD', depart_local: `${d4}T08:15`, arrive_local: `${d4}T15:40`, airline: 'TAAG', flight_no: 'DT652' }, `${d4}T07:15:00Z`);
    requests.flightMaria = await req('maria', 'flight', sTravel, { from: 'LIS', to: 'LAD', depart_local: `${d4}T08:15`, arrive_local: `${d4}T15:40`, airline: 'TAAG', flight_no: 'DT652' }, `${d4}T07:15:00Z`);
    requests.hotelJoao = await req('joao', 'hotel', sHotel, { city: 'Luanda', check_in: d4, check_out: day(5), hotel_name: 'Hotel Presidente' }, `${d4}T13:00:00Z`);
    requests.hotelMaria = await req('maria', 'hotel', sHotel, { city: 'Luanda', check_in: d4, check_out: day(5), hotel_name: 'Hotel Presidente' }, `${d4}T13:00:00Z`);
    requests.hotelTiago = await req('tiago', 'hotel', sHotel, { city: 'Luanda', check_in: d4, check_out: day(5), hotel_name: 'Hotel Presidente' }, `${d4}T13:00:00Z`);
    requests.transferJoao = await req('joao', 'transfer', sTransport, { pickup_local: `${d4}T16:30`, pickup_location: 'Aeroporto 4 de Fevereiro', dropoff_location: 'Hotel Presidente' }, `${d4}T15:30:00Z`);
    requests.transferMaria = await req('maria', 'transfer', sTransport, { pickup_local: `${d4}T16:30`, pickup_location: 'Aeroporto 4 de Fevereiro', dropoff_location: 'Hotel Presidente' }, `${d4}T15:30:00Z`);
    requests.medicalTiago = await req('tiago', 'medical', sMedical, { appointment_local: `${day(3)}T09:00`, clinic: 'Clínica Esperança, Talatona', exam_type: 'Renovação certificado médico offshore' }, `${day(3)}T08:00:00Z`);
    requests.trainingAndre = await req('andre', 'training', sTraining, { course: 'H2S refresher', location: 'Soyo', starts_on: day(12), ends_on: day(12) }, `${day(12)}T07:00:00Z`, cc2.id);
    await one("INSERT INTO service_requests (org_id, reference, personnel_id, supplier_id, type, status, location_tz) VALUES ($1,'KM-REQ-1',$2,$3,'flight','requested','Africa/Luanda') RETURNING id", [orgB.id, bPerson.id, sBTravel]);

    // Verified supplier contacts (recipients can only come from here).
    const contact = async (s: string, name: string, email: string, role = 'to', verified = true) =>
      c.query('INSERT INTO supplier_contacts (org_id, supplier_id, name, email, role, verified, verified_by, verified_at) VALUES ((SELECT org_id FROM suppliers WHERE id = $1),$1,$2,$3,$4,$5,$6,$7)', [
        s,
        name,
        email,
        role,
        verified,
        verified ? users['ana.admin'] : null,
        verified ? new Date() : null,
      ]);
    await contact(sTravel, 'Bookings desk', 'bookings@transafrica-travel.example');
    await contact(sTravel, 'Account manager', 'account.manager@transafrica-travel.example', 'cc');
    await contact(sHotel, 'Reservas', 'reservas@hotel-presidente.example');
    await contact(sTransport, 'Operações', 'operacoes@luanda-transfers.example');
    await contact(sMedical, 'Marcações', 'marcacoes@clinica-esperanca.example');
    await contact(sTraining, 'Course bookings', 'courses@offshore-safety.example');
    await contact(sTransport, 'Unverified address', 'random@luanda-transfers.example', 'cc', false);

    // Provider-specific workbook templates.
    const wb = async (name: string, definition: unknown) => {
      const fam = randomUUID();
      return (await one('INSERT INTO workbook_templates (org_id, family_id, version, name, definition, created_by) VALUES ($1,$2,1,$3,$4,$5) RETURNING id', [orgA.id, fam, name, definition, users['ana.admin']])).id;
    };
    const wFlight = await wb('TransAfrica flight booking list', {
      sheetName: 'Flights {date}',
      title: 'Flight booking request — {crewChange} — {asset}',
      columns: [
        { key: 'request.reference', heading: 'Ref', required: true, width: 16 },
        { key: 'person.full_name', heading: 'Passenger name', required: true, width: 26 },
        { key: 'person.employee_no', heading: 'Employee no.', width: 12 },
        { key: 'person.nationality', heading: 'Nationality', width: 14 },
        { key: 'details.from', heading: 'From', required: true, width: 8 },
        { key: 'details.to', heading: 'To', required: true, width: 8 },
        { key: 'details.depart_local:date', heading: 'Travel date', type: 'date', required: true, width: 12 },
        { key: 'details.depart_local:time', heading: 'Departure', type: 'time', width: 10 },
        { key: 'details.flight_no', heading: 'Preferred flight', width: 12 },
        { key: 'request.booking_reference', heading: 'PNR (supplier)', width: 14 },
      ],
      dateFormat: 'dd/mm/yyyy',
      timeFormat: 'hh:mm',
      print: { orientation: 'landscape', fitToWidth: true, paperSize: 'A4', footer: '&LConfidential — {supplier}&RPage &P of &N' },
    });
    const wHotel = await wb('Lista de alojamento Hotel Presidente', {
      sheetName: 'Alojamento',
      title: 'Lista de alojamento — {crewChange}',
      columns: [
        { key: 'request.reference', heading: 'Ref', required: true, width: 16 },
        { key: 'person.full_name', heading: 'Nome do hóspede', required: true, width: 26 },
        { key: 'person.employee_no', heading: 'N.º colaborador', width: 14 },
        { key: 'details.check_in', heading: 'Entrada', type: 'date', required: true, width: 12 },
        { key: 'details.check_out', heading: 'Saída', type: 'date', required: true, width: 12 },
        { key: 'nights', heading: 'Noites', type: 'formula', formula: '=E{row}-D{row}', width: 8 },
        { key: 'details.room_type', heading: 'Tipo de quarto', width: 14 },
        { key: 'details.confirmation_no', heading: 'N.º confirmação', width: 16 },
      ],
      dateFormat: 'dd/mm/yyyy',
    });
    const wTransport = await wb('Manifesto de transporte', {
      sheetName: 'Manifesto {date}',
      splitBy: 'date',
      columns: [
        { key: 'request.reference', heading: 'Ref', required: true },
        { key: 'person.full_name', heading: 'Passageiro', required: true, width: 26 },
        { key: 'person.phone', heading: 'Telefone', width: 18 },
        { key: 'details.pickup_local:date', heading: 'Data', type: 'date', required: true },
        { key: 'details.pickup_local:time', heading: 'Hora de recolha', type: 'time', required: true },
        { key: 'details.pickup_location', heading: 'Local de recolha', required: true, width: 26 },
        { key: 'details.dropoff_location', heading: 'Destino', required: true, width: 26 },
      ],
    });
    const wMedical = await wb('Lista de marcações médicas', {
      sheetName: 'Marcações',
      columns: [
        { key: 'request.reference', heading: 'Ref', required: true },
        { key: 'person.full_name', heading: 'Nome', required: true, width: 26 },
        { key: 'person.employee_no', heading: 'N.º colaborador' },
        { key: 'details.exam_type', heading: 'Exame', required: true, width: 32 },
        { key: 'details.appointment_local', heading: 'Data e hora pretendidas', type: 'datetime', width: 20 },
      ],
    });

    const tpl = async (supplier: string, type: string, lang: string, name: string, subject: string, body: string, workbook: string | null, extra: Record<string, unknown> = {}) =>
      c.query(
        `INSERT INTO email_templates (org_id, family_id, version, name, supplier_id, request_type, language, subject_format, body_template, workbook_template_id,
           filename_convention, requires_review, response_hours, grouping, provider_instructions, created_by)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [orgA.id, randomUUID(), name, supplier, type, lang, subject, body, workbook, extra.filename ?? '{type}_{crewChange}_{date}.xlsx', extra.review ?? true, extra.hours ?? 24, extra.grouping ?? 'crew_change', extra.instructions ?? null, users['ana.admin']],
      );
    await tpl(sTravel, 'flight', 'en', 'Flight booking request', 'Flight booking request {crewChange} {asset} ({count} pax)',
      'Dear TransAfrica team,\n\nPlease book the flights listed in the attached spreadsheet for crew change {crewChange} ({asset}).\n\n{people}\n\n{instructions}\n\nKind regards,\n{sender}', wFlight,
      { filename: 'FlightRequest_{crewChange}_{date}.xlsx', instructions: 'Please return the PNR for each passenger in the attached file.' });
    await tpl(sHotel, 'hotel', 'pt-PT', 'Pedido de alojamento', 'Pedido de alojamento {crewChange} — {count} hóspedes',
      'Caros colegas,\n\nSolicitamos a reserva de alojamento para os colaboradores indicados na lista em anexo ({crewChange}, {asset}).\n\n{people}\n\nCom os melhores cumprimentos,\n{sender}', wHotel,
      { filename: 'Alojamento_{crewChange}_{date}.xlsx' });
    await tpl(sTransport, 'transfer', 'pt-PT', 'Manifesto de transporte', 'Manifesto de transporte {crewChange} — {date}',
      'Bom dia,\n\nEnviamos em anexo o manifesto de transporte para {crewChange}.\n\n{people}\n\nObrigado,\n{sender}', wTransport, { filename: 'Transporte_{crewChange}_{date}.xlsx', grouping: 'day' });
    await tpl(sMedical, 'medical', 'pt-PT', 'Marcação de exames médicos', 'Marcação de exames médicos — {crewChange}',
      'Bom dia,\n\nSolicitamos a marcação dos exames indicados em anexo.\n\n{people}\n\nCumprimentos,\n{sender}', wMedical, { filename: 'Marcacoes_{crewChange}.xlsx' });
    await tpl(sTraining, 'training', 'en', 'Training booking', 'Training booking request {crewChange}', 'Hello,\n\nPlease book the following course places:\n\n{people}\n\nRegards,\n{sender}', null, { review: false });

    // Tasks: onboarding with an overdue item, and a verification task.
    await c.query(
      `INSERT INTO tasks (org_id, title, kind, status, priority, assignee_id, due_at, personnel_id, created_by) VALUES
        ($1, 'Recolher cópia do certificado BOSIET', 'onboarding', 'done', 'normal', $2, now() - interval '5 days', $3, $2),
        ($1, 'Marcação do exame médico', 'onboarding', 'todo', 'high', $2, now() - interval '1 day', $3, $2),
        ($1, 'Verificar renovação do BOSIET', 'verification', 'todo', 'normal', $2, now() + interval '2 days', $4, $5),
        ($1, 'Confirmar lugares no helicóptero para CC-${year}-0001', 'mobilisation', 'in_progress', 'urgent', $6, now() + interval '2 days', NULL, $2),
        ($1, 'Carregar digitalização atualizada do passaporte', 'document_request', 'todo', 'normal', $7, now() + interval '7 days', $8, $5)`,
      [orgA.id, users['helena.hr'], people.rosa, people.ines, users['carla.coord'], users['carla.coord'], users['joao.employee'], people.joao],
    );
    await c.query("UPDATE tasks SET crew_change_id = $2 WHERE org_id = $1 AND kind = 'mobilisation'", [orgA.id, cc1.id]);

    await c.query('COMMIT');
    return { orgA: orgA.id, orgB: orgB.id, users, people, assets: { aKN, aLB, aB1 }, suppliers: { sTravel, sHotel, sTransport, sMedical, sTraining, sBTravel }, crewChanges: { cc1: cc1.id, cc2: cc2.id }, requests, gap, requirementTypes: { rBOSIET, rHUET, rMED, rH2S, rPASS }, bPerson: bPerson.id, workbooks: { wFlight, wHotel, wTransport, wMedical } };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

export type DemoIds = Awaited<ReturnType<typeof seedDemo>>;
