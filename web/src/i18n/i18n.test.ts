import { describe, expect, it } from 'vitest';
import { en } from './en';
import { pt } from './pt';
import { translate } from './index';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Values that are legitimately identical in both languages (names, codes, loanwords).
const SAME_OK = new Set([
  'app.name', 'lang.en', 'lang.pt-PT', 'type.hotel', 'priority.normal', 'common.copy', 'pkg.cc', 'person.email', 'export.csv',
  'export.xlsx', 'kpi.unit.hours', 'nav.menu', 'admin.aiAnthropic', 'person.classification.general', 'role.supplier',
  'req.field.hotel_name', 'req.field.flight_no', 'common.supplier', 'cc.embarkationMarker', 'cc.embarkation', 'sup.category.travel',
  'role.auditor', 'req.field.cabin', 'settings.connectMicrosoft', 'req.field.clinic', 'msg.title', 'person.status.active', 'status.member.active',
]);

describe('translations', () => {
  it('Portuguese has exactly the same keys as English', () => {
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
  });

  it('no translation is empty and placeholders match', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(pt[k].trim(), k).not.toBe('');
      expect(placeholders(pt[k]), k).toEqual(placeholders(en[k]));
    }
  });

  it('Portuguese strings are actually translated (no accidental English left behind)', () => {
    const same = (Object.keys(en) as (keyof typeof en)[]).filter((k) => en[k] === pt[k] && !SAME_OK.has(k));
    expect(same).toEqual([]);
  });

  it('interpolates parameters and leaves unknown ones visible', () => {
    expect(translate('pt-PT', 'cc.progressDetail', { done: 2, total: 5 })).toBe('2 de 5 serviços confirmados');
    expect(translate('en', 'cc.progressDetail', { done: 2 })).toBe('2 of {total} arrangements confirmed');
  });
});
