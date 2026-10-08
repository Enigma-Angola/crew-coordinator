import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { z } from 'zod';

/* Workbook template definition ----------------------------------------------------------- */

export const columnSchema = z.object({
  key: z.string().max(80),               // field path, e.g. "person.full_name", "details.depart_local:date"
  heading: z.string().max(80),
  type: z.enum(['text', 'date', 'time', 'datetime', 'number', 'formula']).default('text'),
  format: z.string().max(40).optional(),  // Excel number format, e.g. "dd/mm/yyyy", "#,##0.00"
  width: z.number().min(2).max(120).optional(),
  formula: z.string().max(300).optional(), // e.g. "=E{row}-D{row}" (template author controlled)
  required: z.boolean().default(false),
});

export const workbookDefinitionSchema = z.object({
  sheetName: z.string().max(31).default('{type}'), // may use {asset}, {date}, {type}
  splitBy: z.enum(['none', 'asset', 'date']).default('none'),
  separateFiles: z.boolean().default(false),         // split groups into separate files instead of sheets
  title: z.string().max(200).optional(),             // optional title row, supports {crewChange} {asset} {date} {supplier}
  columns: z.array(columnSchema).min(1).max(60),
  dateFormat: z.string().max(20).default('dd/mm/yyyy'),
  timeFormat: z.string().max(20).default('hh:mm'),
  freezeHeader: z.boolean().default(true),
  autoFilter: z.boolean().default(true),
  print: z
    .object({
      orientation: z.enum(['portrait', 'landscape']).default('landscape'),
      fitToWidth: z.boolean().default(true),
      paperSize: z.enum(['A4', 'Letter']).default('A4'),
      header: z.string().max(200).optional(),
      footer: z.string().max(200).optional(),
    })
    .default({ orientation: 'landscape', fitToWidth: true, paperSize: 'A4' }),
  /** When a base file is attached: sheet to fill and first data row (header row = startRow - 1). */
  base: z.object({ sheet: z.string().max(31), startRow: z.number().int().min(2).max(1000) }).optional(),
});

export type WorkbookDefinition = z.infer<typeof workbookDefinitionSchema>;

/** Reference column always present so returned spreadsheets can be matched by stable reference, never by name. */
export const REF_KEY = 'request.reference';
export const META_SHEET = '_cc_meta';

/* Values and safety ---------------------------------------------------------------------- */

/**
 * Spreadsheet formula injection: text that begins with = + - @ or a control character can be
 * interpreted as a formula by spreadsheet software (especially after CSV round trips or
 * re-entry). Such values are prefixed with an apostrophe.
 */
export function neutraliseFormula(v: string) {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export type Row = Record<string, string | number | null>;

function cellValue(col: z.infer<typeof columnSchema>, raw: string | number | null) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (col.type) {
    case 'number':
      return typeof raw === 'number' ? raw : Number.isFinite(Number(raw)) ? Number(raw) : neutraliseFormula(String(raw));
    case 'date': {
      const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : neutraliseFormula(String(raw));
    }
    case 'datetime': {
      const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : neutraliseFormula(String(raw));
    }
    case 'time': {
      const m = String(raw).match(/(\d{2}):(\d{2})/);
      // Excel stores times as a fraction of a day.
      return m ? (+m[1] * 60 + +m[2]) / 1440 : neutraliseFormula(String(raw));
    }
    default:
      return neutraliseFormula(String(raw));
  }
}

/** Validates rows against required columns before anything is generated. */
export function validateRows(def: WorkbookDefinition, rows: Row[], extraRequired: string[] = []) {
  const issues: { reference: string; field: string; code: 'missing' }[] = [];
  const required = new Set([...def.columns.filter((c) => c.required).map((c) => c.key), ...extraRequired]);
  for (const r of rows) {
    for (const key of required) {
      const v = r[key] ?? r[key.split(':')[0]];
      if (v === null || v === undefined || v === '') issues.push({ reference: String(r[REF_KEY]), field: key, code: 'missing' });
    }
  }
  return issues;
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function sheetSafe(name: string) {
  return (name.replace(/[\\/?*[\]:]/g, ' ').trim() || 'Sheet').slice(0, 31);
}

export interface GenerateInput {
  def: WorkbookDefinition;
  rows: Row[];
  vars: Record<string, string>;          // crewChange, asset, date, supplier, type
  meta: Record<string, string>;          // written to the hidden metadata sheet
  baseFile?: Buffer | null;
}

function groupRows(def: WorkbookDefinition, rows: Row[]) {
  if (def.splitBy === 'none') return [{ key: '', rows }];
  const field = def.splitBy === 'asset' ? 'asset.name' : 'group.date';
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = String(r[field] ?? '');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].sort().map(([key, rs]) => ({ key, rows: rs }));
}

/**
 * Generates one or more XLSX files. Returns several buffers when the template asks for
 * separate files per asset or date; otherwise one workbook with a sheet per group.
 */
export async function generateWorkbooks(input: GenerateInput): Promise<{ groupKey: string; buffer: Buffer }[]> {
  const groups = groupRows(input.def, input.rows);
  if (input.def.separateFiles && groups.length > 1) {
    const out = [];
    for (const g of groups) out.push({ groupKey: g.key, buffer: await buildWorkbook(input, [g]) });
    return out;
  }
  return [{ groupKey: '', buffer: await buildWorkbook(input, groups) }];
}

async function buildWorkbook(input: GenerateInput, groups: { key: string; rows: Row[] }[]) {
  const { def } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Crew Coordinator';
  wb.created = new Date(input.meta.generated_at ?? Date.now());
  const columns = def.columns.some((c) => c.key === REF_KEY) ? def.columns : [{ key: REF_KEY, heading: 'Ref', type: 'text' as const, required: true }, ...def.columns];

  if (input.baseFile && def.base) {
    await wb.xlsx.load(input.baseFile as any);
    const ws = wb.getWorksheet(def.base.sheet);
    if (!ws) throw new Error(`base sheet "${def.base.sheet}" not found`);
    const styleRow = ws.getRow(def.base.startRow);
    let r = def.base.startRow;
    for (const g of groups) {
      for (const row of g.rows) {
        writeRow(ws, r, columns, row, def, styleRow);
        r++;
      }
    }
  } else {
    for (const g of groups) {
      const vars = { ...input.vars, asset: def.splitBy === 'asset' ? g.key : input.vars.asset ?? '', date: def.splitBy === 'date' ? g.key : input.vars.date ?? '' };
      let name = sheetSafe(fill(def.sheetName, vars));
      for (let i = 2; wb.getWorksheet(name); i++) name = sheetSafe(`${fill(def.sheetName, vars).slice(0, 27)} (${i})`);
      const ws = wb.addWorksheet(name, {
        pageSetup: {
          orientation: def.print.orientation,
          fitToPage: def.print.fitToWidth,
          fitToWidth: 1,
          fitToHeight: 0,
          paperSize: (def.print.paperSize === 'A4' ? 9 : undefined) as any, // 9 = A4; undefined = Letter (Excel default)
          margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
        },
        headerFooter: { oddHeader: def.print.header ? fill(def.print.header, vars) : undefined, oddFooter: def.print.footer ? fill(def.print.footer, vars) : '&LPage &P of &N' },
      });
      let headerRowNo = 1;
      if (def.title) {
        const t = ws.getRow(1);
        t.getCell(1).value = neutraliseFormula(fill(def.title, vars));
        t.getCell(1).font = { bold: true, size: 13 };
        headerRowNo = 3;
      }
      const header = ws.getRow(headerRowNo);
      columns.forEach((c, i) => {
        const cell = header.getCell(i + 1);
        cell.value = c.heading;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF8FA3BF' } } };
        ws.getColumn(i + 1).width = c.width ?? Math.max(10, Math.min(40, c.heading.length + 4));
      });
      header.height = 22;
      g.rows.forEach((row, j) => writeRow(ws, headerRowNo + 1 + j, columns, row, def));
      if (def.freezeHeader) ws.views = [{ state: 'frozen', ySplit: headerRowNo }];
      if (def.autoFilter && g.rows.length) ws.autoFilter = { from: { row: headerRowNo, column: 1 }, to: { row: headerRowNo + g.rows.length, column: columns.length } };
      ws.pageSetup.printTitlesRow = `${headerRowNo}:${headerRowNo}`;
    }
  }

  // Hidden metadata identifying exactly which generated file this is (used to reconcile returns).
  const meta = wb.getWorksheet(META_SHEET) ?? wb.addWorksheet(META_SHEET);
  meta.state = 'veryHidden';
  Object.entries(input.meta).forEach(([k, v], i) => {
    meta.getCell(i + 1, 1).value = k;
    meta.getCell(i + 1, 2).value = neutraliseFormula(String(v));
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

function writeRow(ws: ExcelJS.Worksheet, rowNo: number, columns: z.infer<typeof columnSchema>[], row: Row, def: WorkbookDefinition, styleRow?: ExcelJS.Row) {
  const r = ws.getRow(rowNo);
  columns.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    if (styleRow && styleRow.number !== rowNo) cell.style = { ...styleRow.getCell(i + 1).style };
    if (c.type === 'formula' && c.formula) {
      cell.value = { formula: c.formula.replace(/^=/, '').replace(/\{row\}/g, String(rowNo)) };
    } else {
      cell.value = cellValue(c, row[c.key] ?? null) as any;
    }
    const fmt = c.format ?? (c.type === 'date' ? def.dateFormat : c.type === 'time' ? def.timeFormat : c.type === 'datetime' ? `${def.dateFormat} ${def.timeFormat}` : undefined);
    if (fmt) cell.numFmt = fmt;
  });
  r.commit?.();
}

/* Base-template inspection --------------------------------------------------------------- */

const KNOWN_UNSUPPORTED: { pattern: RegExp; feature: string }[] = [
  { pattern: /^xl\/vbaProject\.bin$/, feature: 'macros' },
  { pattern: /^xl\/charts\//, feature: 'charts' },
  { pattern: /^xl\/pivotTables\//, feature: 'pivot_tables' },
  { pattern: /^xl\/pivotCache\//, feature: 'pivot_caches' },
  { pattern: /^xl\/slicers\//, feature: 'slicers' },
  { pattern: /^xl\/slicerCaches\//, feature: 'slicers' },
  { pattern: /^xl\/externalLinks\//, feature: 'external_links' },
  { pattern: /^xl\/connections\.xml$/, feature: 'data_connections' },
  { pattern: /^xl\/queryTables\//, feature: 'query_tables' },
  { pattern: /^xl\/threadedComments\//, feature: 'threaded_comments' },
  { pattern: /^xl\/timelines\//, feature: 'timelines' },
  { pattern: /^xl\/drawings\/vmlDrawing/, feature: 'legacy_drawings' },
  { pattern: /^xl\/ctrlProps\//, feature: 'form_controls' },
  { pattern: /^customXml\//, feature: 'custom_xml' },
];

/**
 * Reports template features this generator cannot preserve. Two checks:
 *  1. known unsupported OOXML parts present in the file;
 *  2. a real round trip through the generator, listing any package part that disappears.
 * Generation from a base file is refused while features would be lost, unless an
 * administrator explicitly acknowledges the loss.
 */
export async function inspectTemplate(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const unsupported = new Set<string>();
  for (const p of parts) for (const k of KNOWN_UNSUPPORTED) if (k.pattern.test(p)) unsupported.add(k.feature);
  const sheetXml = await Promise.all(parts.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).map((p) => zip.file(p)!.async('string')));
  if (sheetXml.some((x) => x.includes('<x14:sparklineGroups'))) unsupported.add('sparklines');
  if (sheetXml.some((x) => x.includes('<x14:conditionalFormatting'))) unsupported.add('extended_conditional_formatting');
  if (sheetXml.some((x) => x.includes('<x14:dataValidations'))) unsupported.add('extended_data_validation');

  let lostParts: string[] = [];
  let sheets: string[] = [];
  let loadError: string | null = null;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    sheets = wb.worksheets.map((w) => w.name);
    const out = await JSZip.loadAsync(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
    const outParts = new Set(Object.keys(out.files));
    const ignorable = /^(docProps\/|xl\/calcChain\.xml$|xl\/printerSettings\/|.*\.rels$|\[Content_Types\]\.xml$|xl\/sharedStrings\.xml$|xl\/theme\/)/;
    lostParts = parts.filter((p) => !outParts.has(p) && !ignorable.test(p));
    for (const p of lostParts) {
      const known = KNOWN_UNSUPPORTED.find((k) => k.pattern.test(p));
      unsupported.add(known ? known.feature : 'other_parts');
    }
  } catch (e) {
    loadError = (e as Error).message.slice(0, 200);
  }
  return { ok: unsupported.size === 0 && !loadError, unsupported: [...unsupported].sort(), lostParts, sheets, loadError };
}

/* Reading returned workbooks ------------------------------------------------------------- */

export interface ReadWorkbook {
  meta: Record<string, string>;
  sheets: { name: string; headers: string[]; rows: { rowNo: number; values: Record<string, string | null> }[] }[];
}

function cellText(cell: ExcelJS.Cell): string | null {
  const v = cell.value as any;
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'result' in v) return v.result === undefined || v.result === null ? null : String(v.result instanceof Date ? v.result.toISOString() : v.result);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t: any) => t.text).join('');
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  return String(v);
}

/** Reads a workbook into header-keyed rows. Header detection: first row containing the reference heading. */
export async function readWorkbook(buffer: Buffer, refHeadings: string[]): Promise<ReadWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const meta: Record<string, string> = {};
  const m = wb.getWorksheet(META_SHEET);
  m?.eachRow((row) => {
    const k = cellText(row.getCell(1));
    if (k) meta[k] = cellText(row.getCell(2)) ?? '';
  });
  const sheets: ReadWorkbook['sheets'] = [];
  for (const ws of wb.worksheets) {
    if (ws.name === META_SHEET) continue;
    let headerRow = 0;
    let headers: string[] = [];
    for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
      const vals: string[] = [];
      ws.getRow(r).eachCell({ includeEmpty: true }, (c, col) => (vals[col - 1] = (cellText(c) ?? '').trim()));
      if (vals.some((v) => refHeadings.includes(v))) {
        headerRow = r;
        headers = vals;
        break;
      }
    }
    if (!headerRow) continue;
    const rows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const values: Record<string, string | null> = {};
      let any = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const t = cellText(ws.getRow(r).getCell(i + 1));
        values[h] = t;
        if (t) any = true;
      });
      if (any) rows.push({ rowNo: r, values });
    }
    sheets.push({ name: ws.name, headers, rows });
  }
  return { meta, sheets };
}

/** Converts an Excel cell value read back from a returned workbook to our canonical text form. */
export function canonicalFromCell(type: string, text: string | null): string | null {
  if (text === null) return null;
  const t = text.trim();
  if (!t) return null;
  if (type === 'date') {
    const iso = t.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const eu = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (eu) return `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`;
    return t;
  }
  if (type === 'time') {
    const iso = t.match(/T(\d{2}):(\d{2})/);
    if (iso) return `${iso[1]}:${iso[2]}`;
    const hm = t.match(/^(\d{1,2})[:h](\d{2})/);
    if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
    const frac = Number(t);
    if (Number.isFinite(frac) && frac >= 0 && frac < 1) {
      const mins = Math.round(frac * 1440);
      return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    }
    return t;
  }
  if (type === 'datetime') {
    const iso = t.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (iso) return `${iso[1]}T${iso[2]}`;
    return t;
  }
  if (type === 'number') {
    const n = Number(t.replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''));
    return Number.isFinite(n) ? String(n) : t;
  }
  return t.replace(/^'/, '');
}
