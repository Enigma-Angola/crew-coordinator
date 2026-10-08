import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { canonicalFromCell, generateWorkbooks, inspectTemplate, neutraliseFormula, readWorkbook, validateRows, workbookDefinitionSchema } from '../src/email/xlsx.js';
import { csvCell } from '../src/api/exports.js';

const def = workbookDefinitionSchema.parse({
  sheetName: 'Hotel {date}',
  title: 'Accommodation {crewChange}',
  columns: [
    { key: 'request.reference', heading: 'Ref', required: true },
    { key: 'person.full_name', heading: 'Guest', required: true },
    { key: 'details.check_in', heading: 'Check-in', type: 'date', required: true },
    { key: 'details.check_out', heading: 'Check-out', type: 'date', required: true },
    { key: 'nights', heading: 'Nights', type: 'formula', formula: '=D{row}-C{row}' },
    { key: 'details.pickup_local:time', heading: 'Pickup', type: 'time' },
  ],
  print: { orientation: 'landscape', fitToWidth: true, paperSize: 'A4', footer: 'Page &P' },
});

const rows = [
  { 'request.reference': 'REQ-2026-0001', 'person.full_name': 'João Silva', 'details.check_in': '2026-10-13', 'details.check_out': '2026-10-15', 'details.pickup_local:time': '07:15', 'group.date': '2026-10-13' },
  { 'request.reference': 'REQ-2026-0002', 'person.full_name': '=HYPERLINK("http://evil.example","x")', 'details.check_in': '2026-10-13', 'details.check_out': '2026-10-14', 'details.pickup_local:time': null, 'group.date': '2026-10-13' },
];

describe('XLSX generation from records', () => {
  it('produces a real, editable workbook with headings, typed dates, formulas, print settings and hidden metadata', async () => {
    const [file] = await generateWorkbooks({ def, rows, vars: { crewChange: 'CC-2026-0001', date: '2026-10-13' }, meta: { attachment_id: 'abc', template_version: '3' } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as any);
    const ws = wb.getWorksheet('Hotel 2026-10-13')!;
    expect(ws.getCell('A1').value).toBe('Accommodation CC-2026-0001');
    expect(ws.getRow(3).values).toEqual([undefined, 'Ref', 'Guest', 'Check-in', 'Check-out', 'Nights', 'Pickup']);
    expect(ws.getCell('C4').value).toEqual(new Date(Date.UTC(2026, 9, 13)));
    expect(ws.getCell('C4').numFmt).toBe('dd/mm/yyyy');
    expect((ws.getCell('E4').value as any).formula).toBe('D4-C4');
    // A time is a day fraction; Excel (and exceljs) present it on the 1899-12-30 epoch.
    expect(ws.getCell('F4').value).toEqual(new Date(Date.UTC(1899, 11, 30, 7, 15)));
    expect(ws.getCell('F4').numFmt).toBe('hh:mm');
    expect(ws.pageSetup.orientation).toBe('landscape');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
    const meta = wb.getWorksheet('_cc_meta')!;
    expect(meta.state).toBe('veryHidden');
    expect(meta.getCell('B1').value).toBe('abc');
  });

  it('neutralises spreadsheet formula injection in data cells', async () => {
    const [file] = await generateWorkbooks({ def, rows, vars: {}, meta: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as any);
    const cell = wb.worksheets[0].getCell('B5');
    expect(typeof cell.value).toBe('string');
    expect(String(cell.value).startsWith("'=")).toBe(true);
    expect(neutraliseFormula('+1')).toBe("'+1");
    expect(neutraliseFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutraliseFormula('João')).toBe('João');
    expect(csvCell('=cmd|"/c calc"!A1')).toBe(`"'=cmd|""/c calc""!A1"`);
  });

  it('splits sheets or files by date or asset', async () => {
    const split = workbookDefinitionSchema.parse({ ...def, splitBy: 'date', separateFiles: true, sheetName: 'Manifest {date}' });
    const files = await generateWorkbooks({ def: split, rows: [...rows, { ...rows[0], 'request.reference': 'REQ-2026-0003', 'group.date': '2026-10-14' }], vars: {}, meta: {} });
    expect(files.map((f) => f.groupKey)).toEqual(['2026-10-13', '2026-10-14']);
  });

  it('validates required fields before generating', () => {
    const issues = validateRows(def, [{ ...rows[0], 'details.check_out': null }]);
    expect(issues).toEqual([{ reference: 'REQ-2026-0001', field: 'details.check_out', code: 'missing' }]);
  });

  it('reads returned workbooks back by heading and stable reference', async () => {
    const [file] = await generateWorkbooks({ def, rows, vars: {}, meta: { attachment_id: 'abc' } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as any);
    wb.worksheets[0].getCell('D4').value = new Date(Date.UTC(2026, 9, 16));
    const back = await readWorkbook(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), ['Ref']);
    expect(back.meta.attachment_id).toBe('abc');
    const r = back.sheets[0].rows.find((x) => x.values.Ref === 'REQ-2026-0001')!;
    expect(canonicalFromCell('date', r.values['Check-out'])).toBe('2026-10-16');
    expect(canonicalFromCell('time', r.values.Pickup)).toBe('07:15');
    expect(canonicalFromCell('date', '16/10/2026')).toBe('2026-10-16');
  });
});

describe('base template inspection', () => {
  it('accepts a plain workbook', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Lista').getCell('A1').value = 'Ref';
    const r = await inspectTemplate(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
    expect(r.ok).toBe(true);
    expect(r.sheets).toEqual(['Lista']);
  });

  it('detects and reports features that would be lost instead of silently damaging the file', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Lista').getCell('A1').value = 'Ref';
    const zip = await JSZip.loadAsync(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
    zip.file('xl/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>');
    zip.file('xl/pivotTables/pivotTable1.xml', '<pivotTableDefinition/>');
    zip.file('xl/vbaProject.bin', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    const r = await inspectTemplate(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(r.ok).toBe(false);
    expect(r.unsupported).toEqual(expect.arrayContaining(['charts', 'pivot_tables', 'macros']));
    expect(r.lostParts).toEqual(expect.arrayContaining(['xl/charts/chart1.xml']));
  });
});
