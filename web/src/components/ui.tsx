import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError, loginUrl, onAuthProblem } from '../api';
import { useI18n, type MessageKey } from '../i18n';

/* Icons (stroke icons, 16px) ------------------------------------------------------------- */
const paths: Record<string, string> = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  ship: 'M3 17l2 4h14l2-4M5 17V9h14v8M9 9V5h6v4M12 2v3',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  people: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  check: 'M20 6L9 17l-5-5',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  timeline: 'M3 6h10M7 12h14M3 18h8',
  calendar: 'M3 5h18v16H3zM3 9h18M8 3v4M16 3v4',
  tasks: 'M9 6h12M9 12h12M9 18h12M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  spark: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  truck: 'M2 7h11v9H2zM13 10h4l3 3v3h-7M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 16v-4M12 8h.01',
  x: 'M18 6L6 18M6 6l12 12',
  ok: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
  minus: 'M5 12h14',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  menu: 'M3 6h18M3 12h18M3 18h18',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  chevron: 'M9 18l6-6-6-6',
  chevronL: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
};
export function Icon({ name, size = 16, label }: { name: keyof typeof paths | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={paths[name] ?? paths.info} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#2a78d6" />
      <path d="M8 20l5-9 4 6 3-4 4 7" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* Status --------------------------------------------------------------------------------- */
export type Tone = 'good' | 'warn' | 'serious' | 'critical' | 'info' | 'neutral';
const TONE_ICON: Record<Tone, string> = { good: 'ok', warn: 'clock', serious: 'alert', critical: 'alert', info: 'info', neutral: 'minus' };

const REQUEST_TONE: Record<string, Tone> = { draft: 'neutral', requested: 'info', acknowledged: 'info', quoted: 'warn', proposed: 'warn', change_pending_review: 'serious', confirmed: 'good', completed: 'good', cancelled: 'neutral' };
const CC_TONE: Record<string, Tone> = { draft: 'neutral', planning: 'info', approval_pending: 'warn', approved: 'good', in_progress: 'info', completed: 'good', cancelled: 'neutral' };
const PKG_TONE: Record<string, Tone> = { draft: 'neutral', in_review: 'warn', approved: 'info', queued: 'info', submitting: 'info', submitted: 'good', send_failed: 'critical', send_uncertain: 'serious', cancelled: 'neutral' };
const TASK_TONE: Record<string, Tone> = { todo: 'neutral', in_progress: 'info', blocked: 'critical', done: 'good', cancelled: 'neutral' };
const READY_TONE: Record<string, Tone> = { valid: 'good', expiring_soon: 'info', expires_during: 'warn', pending_verification: 'warn', expired: 'critical', missing: 'critical', not_met: 'critical' };

export function StatusBadge({ kind, status }: { kind: 'request' | 'cc' | 'pkg' | 'task' | 'member' | 'readiness' | 'scan' | 'mailbox'; status: string }) {
  const { tk } = useI18n();
  const map = { request: REQUEST_TONE, cc: CC_TONE, pkg: PKG_TONE, task: TASK_TONE, readiness: READY_TONE } as Record<string, Record<string, Tone>>;
  const fallback: Record<string, Tone> = { active: 'good', pending_approval: 'warn', suspended: 'critical', clean: 'good', quarantined: 'warn', infected: 'critical', scan_failed: 'serious', connected: 'good', reauthorisation_required: 'critical', revoked: 'neutral', error: 'critical', pending: 'warn' };
  const tone = map[kind]?.[status] ?? fallback[status] ?? 'neutral';
  return (
    <span className={`badge ${tone === 'neutral' ? '' : tone}`}>
      <Icon name={TONE_ICON[tone]} size={12} />
      {tk(`status.${kind}.${status}`)}
    </span>
  );
}

export function Badge({ tone = 'neutral', children, icon }: { tone?: Tone; children: ReactNode; icon?: string }) {
  return (
    <span className={`badge ${tone === 'neutral' ? '' : tone}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/* Layout pieces --------------------------------------------------------------------------- */
export function PageHeader({ title, sub, actions, crumbs }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, question, actions, children, className = '', id }: { title?: ReactNode; question?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} aria-labelledby={id}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 id={id}>{title}</h2>}
            {question && <p className="q">{question}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max, label, tone }: { value: number; max: number; label: string; tone?: 'good' }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={`progress ${tone ?? ''}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/* States ---------------------------------------------------------------------------------- */
export function Loading({ rows = 3 }: { rows?: number }) {
  const { t } = useI18n();
  return (
    <div aria-busy="true" aria-live="polite" className="stack" style={{ gap: 8, padding: '8px 0' }}>
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 16, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Empty({ children, icon = 'file' }: { children?: ReactNode; icon?: string }) {
  const { t } = useI18n();
  return (
    <div className="state">
      <Icon name={icon} size={22} />
      <p>{children ?? t('state.empty')}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="state" role="alert">
      <Icon name="alert" size={22} />
      <p>{error ? <ErrorText error={error} /> : t('state.error')}</p>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function ErrorText({ error }: { error: ApiError | { code: string } }) {
  const { t, tk } = useI18n();
  const key = `error.${error.code}`;
  const text = tk(key);
  return <>{text === error.code ? t('error.generic', { code: error.code }) : text}</>;
}

export function Banner({ tone = 'info', icon, children, action }: { tone?: 'info' | 'warn' | 'critical' | 'good'; icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'critical' ? 'alert' : 'status'}>
      <Icon name={icon ?? (tone === 'good' ? 'ok' : tone === 'info' ? 'info' : 'alert')} />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

/** Wraps an async-loaded section with the standard loading, error and empty states. */
export function Async<T>({ state, empty, children }: { state: { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.loading && !state.data) return <Loading />;
  if (!state.data) return <Loading />;
  if (empty && empty(state.data)) return <Empty />;
  return <>{children(state.data)}</>;
}

/* Dialog ---------------------------------------------------------------------------------- */
export function Dialog({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.close)')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <div className="d-head">
          <h2 id={id}>{title}</h2>
          <button className="btn ghost icon close" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="d-body">{children}</div>
        {footer && <div className="d-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* Toasts ---------------------------------------------------------------------------------- */
const ToastCtx = createContext<(msg: ReactNode, tone?: 'ok' | 'error') => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: ReactNode; tone: string }[]>([]);
  const push = useCallback((msg: ReactNode, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className={`toast ${i.tone === 'error' ? 'error' : ''}`} role={i.tone === 'error' ? 'alert' : 'status'}>
            {i.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Runs an action and reports API errors as translated toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: ReactNode): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        if (e instanceof ApiError && e.code !== 'reauth_required' && e.code !== 'edit_conflict') toast(<ErrorText error={e} />, 'error');
        if (e instanceof ApiError && e.code === 'edit_conflict') throw e;
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}

/* Step-up re-authentication ----------------------------------------------------------------- */
export function ReauthGate() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const off = onAuthProblem((e) => {
        if (e.code === 'reauth_required') setOpen(true);
        else if (e.code === 'unauthenticated' && !window.location.pathname.startsWith('/signin') && !window.location.pathname.startsWith('/invite')) {
          window.location.assign('/signin');
        }
      });
    return () => {
      off();
    };
  }, []);
  if (!open) return null;
  return (
    <Dialog
      title={t('auth.reauthTitle')}
      onClose={() => setOpen(false)}
      footer={
        <>
          <button className="btn" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          <a className="btn primary" href={loginUrl({ stepup: true })}>
            <Icon name="lock" /> {t('auth.reauth')}
          </a>
        </>
      }
    >
      <p>{t('auth.reauthHelp')}</p>
    </Dialog>
  );
}

/* Edit conflicts ------------------------------------------------------------------------------ */
export interface ConflictInfo {
  conflicts: { field: string; base?: unknown; theirs?: unknown; mine?: unknown }[];
  currentVersion: number;
}

/** Shows conflicting fields side by side and lets the user keep theirs or mine per field. */
export function ConflictDialog({ info, labelFor, onResolve, onCancel }: { info: ConflictInfo; labelFor: (f: string) => string; onResolve: (keep: Record<string, unknown>, version: number) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<Record<string, 'mine' | 'theirs'>>(Object.fromEntries(info.conflicts.map((c) => [c.field, 'mine'])));
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v).replace('T', ' '));
  return (
    <Dialog
      title={t('conflict.title')}
      onClose={onCancel}
      wide
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            onClick={() => onResolve(Object.fromEntries(info.conflicts.filter((c) => choice[c.field] === 'mine').map((c) => [c.field, c.mine])), info.currentVersion)}
          >
            {t('conflict.apply')}
          </button>
        </>
      }
    >
      <Banner tone="warn">{t('conflict.help')}</Banner>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('conflict.field')}</th>
              <th>{t('conflict.theirs')}</th>
              <th>{t('conflict.mine')}</th>
            </tr>
          </thead>
          <tbody>
            {info.conflicts.map((c) => (
              <tr key={c.field}>
                <td>{labelFor(c.field)}</td>
                <td>
                  <label className="check">
                    <input type="radio" name={`c-${c.field}`} checked={choice[c.field] === 'theirs'} onChange={() => setChoice({ ...choice, [c.field]: 'theirs' })} />
                    <span>
                      {show(c.theirs)} <span className="faint small">({t('conflict.keepTheirs')})</span>
                    </span>
                  </label>
                </td>
                <td>
                  <label className="check">
                    <input type="radio" name={`c-${c.field}`} checked={choice[c.field] === 'mine'} onChange={() => setChoice({ ...choice, [c.field]: 'mine' })} />
                    <span>
                      {show(c.mine)} <span className="faint small">({t('conflict.keepMine')})</span>
                    </span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

export function useT() {
  return useI18n().t;
}
export type { MessageKey };
