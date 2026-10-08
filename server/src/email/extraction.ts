/**
 * Rules-based extraction from supplier emails.
 *
 * Email text is untrusted input. It is only ever parsed into *proposed* values that a person
 * reviews; nothing in a message can trigger tools, change permissions or apply updates by
 * itself. Every proposed value carries the exact source span it came from.
 */

export type Classification = 'acknowledgement' | 'quotation' | 'proposed' | 'confirmed' | 'modification' | 'cancellation' | 'missing_info' | 'unclear';

export interface Span {
  kind: 'body' | 'attachment';
  start: number;
  end: number;
  excerpt: string;
}

export interface Extracted {
  field: string;
  value: string | number;
  source: Span;
}

export interface SegmentResult {
  references: string[];
  classification: Classification;
  alsoConfirms: boolean;
  negatedConfirmation: boolean;
  evidence: Span[];
  fields: Extracted[];
}

const QUOTE_MARKERS = [
  /^On .{5,200}wrote:\s*$/im,
  /^Em .{5,200}escreveu:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Mensagem original\s*-{2,}/im,
  /^_{8,}\s*$/m,
  /^(From|De):\s.+\n(Sent|Enviado|Date|Data):\s/im,
];
const FORWARD_MARKERS = [/^-{5,}\s*Forwarded message\s*-{5,}/im, /^Begin forwarded message:/im, /^-{5,}\s*Mensagem encaminhada\s*-{5,}/im, /^-{2,}\s*Forwarded by/im];

/**
 * Returns the region of the body written by the sender of this message (excluding quoted
 * history), as [start, end) offsets into the original text. For forwarded messages, the
 * forwarded supplier content is included because it is what we need to read.
 */
export function ownContentRange(text: string): { start: number; end: number; isForward: boolean } {
  let start = 0;
  let isForward = false;
  for (const f of FORWARD_MARKERS) {
    const m = f.exec(text);
    if (m) {
      isForward = true;
      start = 0; // keep the forwarder's note and the forwarded content
      break;
    }
  }
  let end = text.length;
  const searchFrom = isForward ? (FORWARD_MARKERS.map((f) => f.exec(text)).find(Boolean)?.index ?? 0) + 20 : 0;
  for (const q of QUOTE_MARKERS) {
    const sub = text.slice(searchFrom);
    let m = q.exec(sub);
    // In a forward, the forwarded block itself starts with From:/Date: headers; skip the first one.
    if (m && isForward && q.source.startsWith('^(From|De)')) {
      const rest = sub.slice(m.index + m[0].length);
      const m2 = q.exec(rest);
      m = m2 ? Object.assign(m2, { index: m.index + m[0].length + m2.index }) : null;
    }
    if (m && searchFrom + m.index < end) end = searchFrom + m.index;
  }
  return { start, end, isForward };
}

const REF_RE = /\b(REQ-\d{4}-\d{4,})\b/g;
const PKG_RE = /\b(PKG-\d{4}-\d{4,})\b/g;

export function findReferences(text: string) {
  return { requests: [...new Set([...text.matchAll(REF_RE)].map((m) => m[1]))], packages: [...new Set([...text.matchAll(PKG_RE)].map((m) => m[1]))] };
}

const P = {
  cancellation: /\b(cancel+ed|cancel+ation confirmed|has been cancel+ed|we (have )?cancel+ed|cancelad[oa]s?|cancelamento|anulad[oa]s?)\b/i,
  negatedConfirm: /\b(not (yet )?(been )?confirmed|unconfirmed|pending confirmation|awaiting confirmation|to be confirmed|\bTBC\b|not able to confirm|cannot confirm|unable to confirm|ainda n[aã]o (est[aá] )?confirmad[oa]|por confirmar|aguarda(r|mos)? confirma[cç][aã]o|n[aã]o ([eé] poss[ií]vel|conseguimos) confirmar)\b/i,
  modification: /\b(changed|rescheduled|re-?timed|amended|new (time|date|flight|pick-?up)|instead of|has been moved|moved to|alterad[oa]s?|altera[cç][aã]o|remarcad[oa]s?|reagendad[oa]s?|nova (hora|data)|passa a ser)\b/i,
  confirmed: /\b(confirmed|is confirmed|we (hereby )?confirm|booking confirmation|confirmation (no|number|#)|confirmad[oa]s?|confirmamos|reserva confirmada|est[aá] confirmad[oa])\b/i,
  proposed: /\b(we propose|proposed|we suggest|suggested option|options? available|available options|please (approve|confirm if)|subject to your approval|propomos|proposta|sugerimos|op[cç][aã]o|op[cç][oõ]es)\b/i,
  quotation: /\b(quote|quotation|price|rate|fare|orçamento|cota[cç][aã]o|pre[cç]o|tarifa)\b/i,
  missing: /\b(please (send|provide|advise|share)|we need|missing|kindly (send|provide)|could you (please )?(send|provide)|required information|em falta|falta(m)?|por favor envi[ea]|necessitamos|precisamos|queira enviar)\b/i,
  acknowledgement: /\b(well received|received|acknowledged?|noted|we will revert|will get back|working on (it|this)|in progress|recebid[oa]s?|bem recebid[oa]|tomamos nota|vamos tratar|daremos (retorno|resposta)|em tratamento)\b/i,
};

function spanOf(text: string, offset: number, m: RegExpExecArray | RegExpMatchArray): Span {
  const s = offset + (m.index ?? 0);
  const lineStart = text.lastIndexOf('\n', s - 1) + 1;
  const lineEndIdx = text.indexOf('\n', s);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  return { kind: 'body', start: s, end: s + m[0].length, excerpt: text.slice(lineStart, lineEnd).trim().slice(0, 240) };
}

export function classify(full: string, offset: number, segment: string): Pick<SegmentResult, 'classification' | 'alsoConfirms' | 'negatedConfirmation' | 'evidence'> {
  const hit = (re: RegExp) => re.exec(segment);
  const ev: Span[] = [];
  const c = hit(P.cancellation);
  const neg = hit(P.negatedConfirm);
  const mod = hit(P.modification);
  // Confirmation words inside a negation ("not yet confirmed") do not count.
  const conf = !neg ? hit(P.confirmed) : null;
  const prop = hit(P.proposed);
  const quote = hit(P.quotation);
  const miss = hit(P.missing);
  const ack = hit(P.acknowledgement);
  let classification: Classification = 'unclear';
  if (c) classification = 'cancellation';
  else if (mod) classification = 'modification';
  else if (conf) classification = 'confirmed';
  else if (prop) classification = 'proposed';
  else if (quote && /\d/.test(segment)) classification = 'quotation';
  else if (miss) classification = 'missing_info';
  else if (ack) classification = 'acknowledgement';
  for (const m of [c, mod, conf, neg, prop, quote, miss, ack]) if (m) ev.push(spanOf(full, offset, m));
  return { classification, alsoConfirms: classification === 'modification' && !!conf, negatedConfirmation: !!neg, evidence: ev };
}

/* Dates and times ------------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, janeiro: 1, feb: 2, february: 2, fev: 2, fevereiro: 2, mar: 3, march: 3, marco: 3, março: 3, apr: 4, april: 4, abr: 4, abril: 4,
  may: 5, mai: 5, maio: 5, jun: 6, june: 6, junho: 6, jul: 7, july: 7, julho: 7, aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9, set: 9, setembro: 9,
  oct: 10, october: 10, out: 10, outubro: 10, nov: 11, november: 11, novembro: 11, dec: 12, december: 12, dez: 12, dezembro: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const pad = (n: number) => String(n).padStart(2, '0');

const DATE_PATTERNS: { re: RegExp; parse: (m: RegExpExecArray, year: number) => string | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parse: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  // European day-first numeric dates (assumption recorded on each proposal).
  { re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g, parse: (m) => (+m[2] <= 12 && +m[1] <= 31 ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:de\\s+)?(${MONTH_ALT})\\.?,?\\s*(?:de\\s+)?(\\d{4})\\b`, 'gi'), parse: (m) => `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}` },
  { re: new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), parse: (m) => `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(+m[2])}` },
  // Airline style "14OCT" (year inferred from the request).
  { re: new RegExp(`\\b(\\d{1,2})(${MONTH_ALT.toUpperCase()})\\b`, 'g'), parse: (m, year) => (MONTHS[m[2].toLowerCase()] ? `${year}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}` : null) },
];

export function findDates(text: string, year: number) {
  const out: { value: string; index: number; length: number }[] = [];
  for (const p of DATE_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const v = p.parse(m, year);
      if (v && !out.some((o) => m!.index >= o.index && m!.index < o.index + o.length)) out.push({ value: v, index: m.index, length: m[0].length });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function findTimes(text: string) {
  const out: { value: string; index: number; length: number }[] = [];
  const re = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b(?!\s*(?:kg|km|%))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ value: `${pad(+m[1])}:${m[2]}`, index: m.index, length: m[0].length });
  return out;
}

/* Field extraction ---------------------------------------------------------------------- */

function money(text: string) {
  const re = /(?:\b(USD|EUR|AOA|GBP|ZAR|BRL|Kz)\s?|(US\$|€|\$)\s?)(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|AOA|GBP|ZAR|BRL|Kz|€)\b/g;
  const out: { amount: number; currency: string; index: number; length: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const cur = (m[1] ?? m[2] ?? m[5] ?? '').toUpperCase();
    const currency = cur === '€' ? 'EUR' : cur === 'KZ' ? 'AOA' : cur === '$' || cur === 'US$' ? 'USD' : cur;
    const raw = (m[3] ?? m[4] ?? '').replace(/\s/g, '');
    const lastSep = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
    const decimals = lastSep >= 0 && raw.length - lastSep - 1 <= 2;
    const normalised = decimals ? raw.slice(0, lastSep).replace(/[.,]/g, '') + '.' + raw.slice(lastSep + 1) : raw.replace(/[.,]/g, '');
    const amount = Number(normalised);
    if (Number.isFinite(amount) && currency) out.push({ amount, currency, index: m.index, length: m[0].length });
  }
  return out;
}

const FLIGHT_RE = /\b(?!REQ\b|PKG\b)([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/g;
const AIRPORT_PAIR_RE = /\b([A-Z]{3})\b\s*(?:-|–|→|>|to|para|\/)\s*\b([A-Z]{3})\b/;
const BOOKING_RE = /\b(?:PNR|booking\s*(?:ref(?:erence)?|code|no\.?|number)|record\s*locator|reservation\s*(?:no\.?|number|code)|localizador|c[oó]digo\s*de\s*reserva|refer[eê]ncia\s*(?:da\s*)?reserva)\s*[:#-]?\s*([A-Z0-9]{5,10})\b/i;
const HOTEL_CONF_RE = /\b(?:confirmation\s*(?:no\.?|number|#|code)?|n\.?[ºo]?\s*(?:de\s*)?confirma[cç][aã]o)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,19})\b/i;

/**
 * Extracts candidate values for a given request type from a segment of text.
 * `full` and `offset` let every value point back to its exact location in the message.
 */
export function extractFields(full: string, offset: number, segment: string, type: string, year: number): Extracted[] {
  const out: Extracted[] = [];
  const push = (field: string, value: string | number, index: number, length: number) =>
    out.push({ field, value, source: spanOf(full, offset, Object.assign([segment.substr(index, length)], { index }) as any) });
  const dates = findDates(segment, year);
  const times = findTimes(segment);
  const lines = segment.split('\n');
  let lineOffset = 0;
  const nearestDate = (idx: number) => [...dates].reverse().find((d) => d.index <= idx) ?? dates.find((d) => d.index > idx) ?? null;

  const booking = BOOKING_RE.exec(segment);
  if (booking) push('booking_reference', booking[1].toUpperCase(), booking.index + booking[0].lastIndexOf(booking[1]), booking[1].length);

  for (const mo of money(segment)) {
    push('cost_amount', mo.amount, mo.index, mo.length);
    push('cost_currency', mo.currency, mo.index, mo.length);
    break; // the first amount is proposed; others are visible in the source text
  }

  if (type === 'flight') {
    for (const line of lines) {
      FLIGHT_RE.lastIndex = 0;
      const fm = FLIGHT_RE.exec(line);
      const hasContext = /\b(flight|voo|flt|dep|arr|partida|chegada|ETD|ETA)\b/i.test(line) || AIRPORT_PAIR_RE.test(line) || findTimes(line).length >= 1;
      if (fm && hasContext) {
        push('details.flight_no', `${fm[1]}${fm[2]}`, lineOffset + fm.index, fm[0].length);
        const ap = AIRPORT_PAIR_RE.exec(line);
        if (ap) {
          push('details.from', ap[1], lineOffset + ap.index, ap[0].length);
          push('details.to', ap[2], lineOffset + ap.index, ap[0].length);
        }
        const lt = findTimes(line);
        const d = findDates(line, year)[0] ?? nearestDate(lineOffset);
        if (d && lt[0]) push('details.depart_local', `${d.value}T${lt[0].value}`, lineOffset + lt[0].index, lt[0].length);
        if (d && lt[1]) push('details.arrive_local', `${d.value}T${lt[1].value}`, lineOffset + lt[1].index, lt[1].length);
        break;
      }
      lineOffset += line.length + 1;
    }
  }

  if (type === 'hotel') {
    const conf = HOTEL_CONF_RE.exec(segment);
    if (conf && conf[1].length >= 4 && /\d/.test(conf[1])) push('details.confirmation_no', conf[1].toUpperCase(), conf.index + conf[0].lastIndexOf(conf[1]), conf[1].length);
    const ci = /\b(check[- ]?in|entrada|chegada)\b[^\n]{0,40}/i.exec(segment);
    const co = /\b(check[- ]?out|sa[ií]da|partida)\b[^\n]{0,40}/i.exec(segment);
    if (ci) {
      const d = findDates(ci[0], year)[0];
      if (d) push('details.check_in', d.value, ci.index + d.index, d.length);
    }
    if (co) {
      const d = findDates(co[0], year)[0];
      if (d) push('details.check_out', d.value, co.index + d.index, d.length);
    }
    const hn = /\b(?:hotel)\s*[:\-–]\s*([^\n,]{3,80})/i.exec(segment);
    if (hn) push('details.hotel_name', hn[1].trim(), hn.index + hn[0].indexOf(hn[1]), hn[1].trim().length);
  }

  if (type === 'transfer') {
    const pu = /\b(pick[- ]?up|recolha|hora de recolha|pickup time)\b[^\n]{0,60}/i.exec(segment);
    if (pu) {
      const t = findTimes(pu[0])[0];
      const d = findDates(pu[0], year)[0] ?? nearestDate(pu.index);
      if (t && d) push('details.pickup_local', `${d.value}T${t.value}`, pu.index + t.index, t.length);
    }
  }

  if (type === 'medical') {
    const ap = /\b(appointment|consulta|exame|marca[cç][aã]o|scheduled|agendad[oa])\b[^\n]{0,80}/i.exec(segment);
    const region = ap ? ap[0] : segment;
    const base = ap ? ap.index : 0;
    const d = findDates(region, year)[0] ?? (ap ? nearestDate(ap.index) : null);
    const t = findTimes(region)[0];
    if (d && t) push('details.appointment_local', `${d.value}T${t.value}`, base + t.index, t.length);
  }

  if (type === 'training') {
    const range = /\b(?:from|de|desde)\s+([^\n]{6,30}?)\s+(?:to|until|a|até)\s+([^\n]{6,30})/i.exec(segment);
    if (range) {
      const a = findDates(range[1], year)[0];
      const b = findDates(range[2], year)[0];
      if (a) push('details.starts_on', a.value, range.index + range[0].indexOf(range[1]), range[1].length);
      if (b) push('details.ends_on', b.value, range.index + range[0].indexOf(range[2]), range[2].length);
    } else if (dates[0]) push('details.starts_on', dates[0].value, dates[0].index, dates[0].length);
  }

  // Single unattached time with a date (e.g. "new time 07:15 on 14/10/2026") for transfers/medical.
  if (!out.some((f) => f.field.endsWith('_local')) && (type === 'transfer' || type === 'medical') && times[0] && dates[0]) {
    push(type === 'transfer' ? 'details.pickup_local' : 'details.appointment_local', `${dates[0].value}T${times[0].value}`, times[0].index, times[0].length);
  }
  return out;
}

/**
 * Splits the sender's content into per-request segments using reference tokens, so that a
 * reply covering several requests yields separate proposals for each.
 */
export function analyse(full: string, knownRefs: string[], year: number, typeOf: (ref: string) => string | undefined) {
  const range = ownContentRange(full);
  const own = full.slice(range.start, range.end);
  const tokens = [...own.matchAll(REF_RE)].filter((m) => knownRefs.includes(m[1]));
  const segments: { refs: string[]; start: number; end: number }[] = [];
  if (!tokens.length) segments.push({ refs: [], start: range.start, end: range.end });
  else {
    // Text before the first reference applies to every request (greeting, general statements).
    const preamble = { start: range.start, end: range.start + tokens[0].index! };
    tokens.forEach((t, i) => {
      const lineStart = own.lastIndexOf('\n', t.index! - 1) + 1;
      const next = tokens[i + 1];
      const nextLineStart = next ? own.lastIndexOf('\n', next.index! - 1) + 1 : own.length;
      if (next && nextLineStart === lineStart) return; // several refs on one line share the segment below
      const refsOnLine = tokens.filter((x) => own.lastIndexOf('\n', x.index! - 1) + 1 === lineStart).map((x) => x[1]);
      segments.push({ refs: refsOnLine, start: range.start + lineStart, end: range.start + nextLineStart });
    });
    if (preamble.end > preamble.start) segments.unshift({ refs: ['*'], start: preamble.start, end: preamble.end });
  }
  const results = segments.map((s) => {
    const text = full.slice(s.start, s.end);
    const cls = classify(full, s.start, text);
    const fields = s.refs.length === 1 && s.refs[0] !== '*' ? extractFields(full, s.start, text, typeOf(s.refs[0]) ?? '', year) : [];
    return { ...s, text, ...cls, fields };
  });
  return { range, results };
}
