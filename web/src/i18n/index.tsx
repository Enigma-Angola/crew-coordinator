import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { pt } from './pt';

export type Lang = 'pt-PT' | 'en';
export const DICTS: Record<Lang, Record<MessageKey, string>> = { en, 'pt-PT': pt };
const INTL_LOCALE: Record<Lang, string> = { en: 'en-GB', 'pt-PT': 'pt-PT' };

export function translate(lang: Lang, key: MessageKey, params: Record<string, unknown> = {}) {
  const s = DICTS[lang][key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('cc.lang');
    if (saved === 'en' || saved === 'pt-PT') return saved;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith('pt') ? 'pt-PT' : 'en';
}

interface I18n {
  lang: Lang;
  locale: string;
  timeZone: string;
  setLang: (l: Lang) => void;
  setTimeZone: (tz: string) => void;
  t: (key: MessageKey, params?: Record<string, unknown>) => string;
  /** Translate a dynamic key (status codes etc.), falling back to the raw code. */
  tk: (key: string, params?: Record<string, unknown>) => string;
  date: (v: string | Date | null | undefined) => string;
  dateTime: (v: string | Date | null | undefined, tz?: string) => string;
  time: (v: string | Date | null | undefined, tz?: string) => string;
  /** A local wall-clock value ("2026-10-14T08:15") shown as-is with its zone label. */
  wall: (v: string | null | undefined, tz: string) => string;
  tzName: (tz?: string) => string;
  number: (v: number | null | undefined, digits?: number) => string;
  money: (v: number | null | undefined, currency: string) => string;
  relative: (v: string | Date) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [timeZone, setTimeZone] = useState<string>(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Luanda');
  const locale = INTL_LOCALE[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem('cc.lang', lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const value = useMemo<I18n>(() => {
    const t = (key: MessageKey, params?: Record<string, unknown>) => translate(lang, key, params);
    const tk = (key: string, params?: Record<string, unknown>) => (key in en ? translate(lang, key as MessageKey, params) : key.split('.').pop() ?? key);
    const tzName = (tz = timeZone) =>
      new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz;
    const date = (v: string | Date | null | undefined) => {
      if (!v) return '—';
      const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v);
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: typeof v === 'string' && v.length === 10 ? 'UTC' : timeZone }).format(d);
    };
    const dateTime = (v: string | Date | null | undefined, tz = timeZone) =>
      v ? `${new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(v))} ${tzName(tz)}` : '—';
    const time = (v: string | Date | null | undefined, tz = timeZone) => (v ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(v)) : '—');
    const wall = (v: string | null | undefined, tz: string) => {
      if (!v) return '—';
      const [d, tm] = v.split('T');
      return `${date(d)}${tm ? ` ${tm}` : ''} ${tzName(tz)}`;
    };
    const number = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v));
    const money = (v: number | null | undefined, currency: string) => (v === null || v === undefined ? '—' : new Intl.NumberFormat(locale, { style: 'currency', currency }).format(v));
    const relative = (v: string | Date) => {
      const diff = (new Date(v).getTime() - Date.now()) / 1000;
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      const abs = Math.abs(diff);
      if (abs < 60) return rtf.format(Math.round(diff), 'second');
      if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
      if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
      return rtf.format(Math.round(diff / 86400), 'day');
    };
    return { lang, locale, timeZone, setLang, setTimeZone, t, tk, date, dateTime, time, wall, tzName, number, money, relative };
  }, [lang, locale, timeZone, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const c = useContext(Ctx);
  if (!c) throw new Error('I18nProvider missing');
  return c;
}

export type { MessageKey };
