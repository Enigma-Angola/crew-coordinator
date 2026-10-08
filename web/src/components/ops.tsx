import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { useSession } from '../session';
import { useApi } from '../hooks';
import { Badge, Banner, Empty, Icon, StatusBadge, useAction } from './ui';

/* KPI card -------------------------------------------------------------------------------- */
export interface Kpi {
  code: string;
  unit: 'count' | 'percent' | 'hours' | 'money';
  value: number | null;
  breakdown: Record<string, number> | null;
  samples: number;
  status: 'ok' | 'insufficient_data';
  period: { from: string; to: string };
  comparison: { period: { from: string; to: string }; value: number | null; status: string } | null;
}

export function KpiCard({ kpi, onDrill, onHide }: { kpi: Kpi; onDrill: () => void; onHide?: () => void }) {
  const { t, tk, number, money, date } = useI18n();
  const fmt = (v: number | null) =>
    v === null ? '—' : kpi.unit === 'percent' ? `${number(v, 1)}%` : kpi.unit === 'hours' ? t('kpi.unit.hours', { value: number(v, 1) }) : number(v);
  const label = tk(`kpi.${kpi.code}`);
  const sameDay = kpi.period.from === kpi.period.to;
  return (
    <article className="card kpi" aria-label={label}>
      <h3 className="label">{label}</h3>
      {kpi.status === 'insufficient_data' ? (
        <div>
          <div className="value na">{t('state.insufficient')}</div>
          <div className="meta">{t('state.insufficientHelp')}</div>
        </div>
      ) : kpi.unit === 'money' ? (
        <div className="money-list">
          {kpi.breakdown && Object.keys(kpi.breakdown).length ? Object.entries(kpi.breakdown).map(([cur, v]) => <span key={cur}>{money(v, cur)}</span>) : <span>{number(0)}</span>}
        </div>
      ) : (
        <div className="value">{fmt(kpi.value)}</div>
      )}
      {kpi.breakdown && kpi.unit !== 'money' && kpi.status === 'ok' && (
        <div className="breakdown">
          {Object.entries(kpi.breakdown)
            .filter(([k]) => !['people', 'tasks_done', 'tasks_total'].includes(k))
            .map(([k, v]) => (
              <span key={k}>
                <strong>{number(v)}</strong> {k in { overdue: 1, on_time: 1, expired: 1, expiring: 1 } ? tk(`kpi.breakdown.${k}`) : tk(`type.${k}`)}
              </span>
            ))}
        </div>
      )}
      <div className="meta">
        {sameDay ? t('kpi.periodToday') : t('kpi.period', { from: date(kpi.period.from), to: date(kpi.period.to) })}
        {' · '}
        {kpi.comparison ? (kpi.comparison.status === 'insufficient_data' ? `${t('kpi.noComparison')} (${t('state.insufficient').toLowerCase()})` : t('kpi.vs', { value: fmt(kpi.comparison.value) })) : t('kpi.noComparison')}
        {kpi.unit !== 'count' && kpi.status === 'ok' && ` · ${t('kpi.samples', { count: kpi.samples })}`}
      </div>
      <p className="def">{tk(`kpi.${kpi.code}.def`)}</p>
      <button className="drill btn ghost" style={{ background: 'transparent', border: 0 }} onClick={onDrill} aria-label={`${label}: ${t('dash.drill')}`} />
      {onHide && (
        <button className="hide btn ghost icon sm" onClick={onHide} aria-label={t('dash.hideCard')} title={t('dash.hideCard')}>
          <Icon name="x" size={14} />
        </button>
      )}
    </article>
  );
}

/* Insights ---------------------------------------------------------------------------------- */
export interface Insight {
  id: string;
  kind: 'fact' | 'rule_warning' | 'prediction';
  code: string;
  severity: 'info' | 'warning' | 'critical';
  params: Record<string, any>;
  supporting: { type: string; id: string; label: string; role?: string }[];
  assumptions: string[];
  actions: { code: string; [k: string]: any }[];
  crew_change_id: string | null;
  personnel_id: string | null;
  request_id: string | null;
  detected_at: string;
}

const linkFor = (type: string, id: string) =>
  ({ request: `/requests/${id}`, personnel: `/personnel/${id}`, crew_change: `/crew-changes/${id}`, task: `/tasks?focus=${id}`, assignment: '/rotation', credential: '' })[type] ?? '';

export function InsightCard({ insight, onChanged }: { insight: Insight; onChanged?: () => void }) {
  const { t, tk, date, wall } = useI18n();
  const { can } = useSession();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const p = { ...insight.params };
  for (const k of ['expiresOn', 'startsOn', 'endsOn', 'checkIn']) if (p[k]) p[k] = date(p[k]);
  for (const k of ['pickupLocal', 'arriveLocal', 'departLocal']) if (p[k]) p[k] = wall(p[k], 'Africa/Luanda');
  if (p.dueAt) p.dueAt = date(p.dueAt);
  const act = async (a: Insight['actions'][number]) => {
    if (a.code === 'prepare_amendment' && can('email:prepare')) {
      const r = await run(() => api('/api/packages/prepare', { body: { requestIds: a.requestIds, purpose: 'amendment' } }));
      if (r?.packages?.[0]) nav(`/communications/packages/${r.packages[0].id}`);
      return;
    }
    if (a.code === 'reassess_readiness' || a.code === 'request_document') return nav(`/personnel/${a.personnelId}`);
    if (a.code === 'assign_candidate' || a.code === 'source_externally') return nav('/rotation');
    if (a.code === 'notify_assignee') return nav(`/tasks?focus=${a.taskId}`);
    if (a.code === 'prepare_reminder' || a.code === 'consider_early_follow_up') return nav('/communications');
  };
  return (
    <div className={`insight ${insight.severity}`}>
      <div className="row between">
        <span className={`kind ${insight.kind}`} title={tk(`insight.kind.${insight.kind}Help`)}>
          <Icon name={insight.kind === 'prediction' ? 'spark' : insight.kind === 'fact' ? 'info' : 'alert'} size={12} />
          {tk(`insight.kind.${insight.kind}`)}
        </span>
        <Badge tone={insight.severity === 'critical' ? 'critical' : insight.severity === 'warning' ? 'warn' : 'info'}>{tk(`insight.severity.${insight.severity}`)}</Badge>
      </div>
      <div className="title">{tk(`insight.${insight.code}`, p)}</div>
      <details>
        <summary>
          {t('insight.basedOn')} ({insight.supporting.length}) · {t('insight.assumptions')} ({insight.assumptions.length})
        </summary>
        <ul>
          {insight.supporting.map((s) => (
            <li key={`${s.type}${s.id}`}>
              {linkFor(s.type, s.id) ? <Link to={linkFor(s.type, s.id)}>{s.label}</Link> : s.label}
              {s.role && <span className="faint"> · {s.role === 'candidate' ? t('insight.action.assign_candidate').toLowerCase() : s.role}</span>}
            </li>
          ))}
        </ul>
        <ul>
          {insight.assumptions.map((a) => (
            <li key={a}>{tk(`assumption.${a}`)}</li>
          ))}
        </ul>
      </details>
      <div className="row">
        {insight.actions.map((a) => (
          <button key={a.code} className="btn sm" disabled={busy} onClick={() => act(a)} title={t('insight.suggested')}>
            {tk(`insight.action.${a.code}`)}
          </button>
        ))}
        <button className="btn ghost sm" disabled={busy} onClick={() => run(() => api(`/api/insights/${insight.id}/acknowledge`, { body: {} })).then(onChanged)}>
          {t('insight.acknowledge')}
        </button>
      </div>
    </div>
  );
}

export function InsightList({ items, onChanged, empty }: { items: Insight[]; onChanged?: () => void; empty?: string }) {
  if (!items.length) return <Empty icon="ok">{empty}</Empty>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map((i) => (
        <InsightCard key={i.id} insight={i} onChanged={onChanged} />
      ))}
    </div>
  );
}

/* Request stage timeline ---------------------------------------------------------------------- */
export function RequestStages({ requestId }: { requestId: string }) {
  const { t, tk, dateTime } = useI18n();
  const s = useApi<any>(`/api/requests/${requestId}/timeline`, [requestId]);
  if (!s.data) return null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <ol className="steps" aria-label={t('req.timeline')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {s.data.stages.map((st: any) => (
          <li key={st.stage} className={`step ${st.reachedAt ? 'done' : ''}`}>
            <span className="node" aria-hidden />
            <div className="lbl">{tk(`req.stage.${st.stage}`)}</div>
            <div className="when">{st.reachedAt ? dateTime(st.reachedAt) : '—'}</div>
            <span className="sr-only">{st.reachedAt ? t('common.yes') : t('common.no')}</span>
          </li>
        ))}
      </ol>
      <div className="row small">
        <strong>{t('req.business')}:</strong> <StatusBadge kind="request" status={s.data.business} />
        <strong style={{ marginLeft: 12 }}>{t('req.technical')}:</strong>
        {s.data.technical.length ? s.data.technical.map((x: any, i: number) => <StatusBadge key={i} kind="pkg" status={x.status} />) : '—'}
      </div>
      <p className="small faint">{t('req.technicalHelp')}</p>
    </div>
  );
}

/* Mobilisation timeline ------------------------------------------------------------------------- */
// Each person gets up to three tracks so overlapping arrangements never hide each other.
const TRACK: Record<string, number> = { flight: 0, training: 0, hotel: 1, transfer: 2, medical: 2, immigration: 2 };
const PX_PER_HOUR = 14;

export function MobilisationTimeline({ people, requests, embarkationAt }: { people: any[]; requests: any[]; embarkationAt: string | null }) {
  const { t, tk, time, tzName, locale } = useI18n();
  const joining = people.filter((p) => p.direction === 'on');
  const live = requests.filter((r) => r.starts_at && r.status !== 'cancelled' && joining.some((p) => p.personnel_id === r.personnel_id));
  const times = live.flatMap((r) => [r.starts_at, r.ends_at]).filter(Boolean).map((v: string) => new Date(v).getTime());
  if (embarkationAt) times.push(new Date(embarkationAt).getTime());
  if (!joining.length || !times.length) return <Empty icon="timeline" />;
  const tz = live[0]?.location_tz ?? 'Africa/Luanda';
  const from = Math.floor((Math.min(...times) - 3 * 3600_000) / 3600_000) * 3600_000;
  const to = Math.max(...times) + 4 * 3600_000;
  const hoursSpan = (to - from) / 3600_000;
  const width = Math.max(560, hoursSpan * PX_PER_HOUR);
  const x = (v: number) => ((v - from) / 3600_000) * PX_PER_HOUR;
  const ticks: number[] = [];
  for (let h = Math.ceil(from / (6 * 3600_000)) * 6 * 3600_000; h < to; h += 6 * 3600_000) ticks.push(h);
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', day: '2-digit', timeZone: tz });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <MobilisationScroller focusX={x(Math.min(...live.filter((r) => r.type === 'flight').map((r) => new Date(r.starts_at).getTime()), Number.MAX_SAFE_INTEGER) === Number.MAX_SAFE_INTEGER ? from : Math.min(...live.filter((r) => r.type === 'flight').map((r) => new Date(r.starts_at).getTime())))}>
        <div className="gantt-grid" style={{ gridTemplateColumns: `190px ${width}px`, minWidth: 190 + width }}>
          <div role="row" style={{ display: 'contents' }}>
            <div className="lane-label head" role="columnheader" />
            <div className="lane head" role="columnheader">
              {ticks.map((h) => (
                <span key={h} style={{ left: x(h) }}>
                  {dayFmt.format(new Date(h))} {time(new Date(h), tz)}
                </span>
              ))}
            </div>
          </div>
          {joining.map((p) => {
            const rs = live.filter((r) => r.personnel_id === p.personnel_id);
            const used = [...new Set(rs.map((r) => TRACK[r.type] ?? 2))].sort();
            const tracks = Math.max(used.length, 1);
            const h = 10 + tracks * 28;
            return (
              <div key={p.personnel_id} role="row" style={{ display: 'contents' }}>
                <div className="lane-label" role="rowheader" style={{ minHeight: h }}>
                  <span className="t">{p.full_name}</span>
                  <span className="faint small">{p.job_title}</span>
                </div>
                <div className="lane" role="cell" style={{ minHeight: h }}>
                  {ticks.map((tk2) => (
                    <span key={tk2} className="vline" style={{ left: x(tk2) }} />
                  ))}
                  {embarkationAt && <span className="embark" style={{ left: x(new Date(embarkationAt).getTime()) }} title={t('cc.embarkationMarker')} />}
                  {rs.map((r) => {
                    const st = new Date(r.starts_at).getTime();
                    const en = r.ends_at ? new Date(r.ends_at).getTime() : st + 90 * 60_000;
                    const confirmed = ['confirmed', 'completed'].includes(r.status);
                    const track = used.indexOf(TRACK[r.type] ?? 2);
                    const label = `${tk(`type.${r.type}`)} · ${time(r.starts_at, r.location_tz)}`;
                    return (
                      <Link
                        key={r.id}
                        to={`/requests/${r.id}`}
                        className={`seg ${r.type} ${confirmed ? '' : 'unconfirmed'}`}
                        style={{ left: x(st), width: Math.max(x(en) - x(st), label.length * 6.6 + 18), top: 6 + track * 28 }}
                        title={`${r.reference} · ${label} · ${tk(`status.request.${r.status}`)}`}
                        aria-label={`${r.reference}, ${label}, ${tk(`status.request.${r.status}`)}`}
                      >
                        {label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </MobilisationScroller>
      <div className="legend">
        {(['flight', 'hotel', 'transfer', 'medical'] as const).map((k) => (
          <span key={k}>
            <span className={`swatch ${k}`} />
            {tk(`type.${k}`)}
          </span>
        ))}
        <span>
          <span className="key" style={{ background: 'repeating-linear-gradient(135deg, var(--border-strong) 0 3px, transparent 3px 6px)' }} />
          {t('status.request.requested')} / {t('comm.awaitingResponse').toLowerCase()}
        </span>
        <span>
          <span className="key" style={{ background: 'var(--brand)', width: 3 }} />
          {t('cc.embarkationMarker')}
        </span>
        <span className="faint">{t('timezone.shownIn', { tz: tzName(tz) })}</span>
      </div>
    </div>
  );
}

/** Horizontal scroll container that opens with the first travel movement in view. */
function MobilisationScroller({ focusX, children }: { focusX: number; children: React.ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = Math.max(0, focusX - 40);
  }, [focusX]);
  return (
    <div className="gantt" role="table" aria-label={t('cc.mobilisation')} ref={ref} tabIndex={0}>
      {children}
    </div>
  );
}

/* Rotation timeline ---------------------------------------------------------------------------- */
export function RotationTimeline({ rows, from, to }: { rows: any[]; from: string; to: string }) {
  const { t, date } = useI18n();
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime() + 86400_000;
  const span = end - start;
  const pct = (d: string, plusDay = false) => `${Math.max(0, Math.min(100, ((new Date(`${d}T00:00:00Z`).getTime() + (plusDay ? 86400_000 : 0) - start) / span) * 100))}%`;
  const weeks: string[] = [];
  for (let d = start; d < end; d += 7 * 86400_000) weeks.push(new Date(d).toISOString().slice(0, 10));
  const lanes = useMemo(() => {
    const map = new Map<string, { key: string; asset: string; position: string; items: any[] }>();
    for (const r of rows) {
      const key = `${r.asset_code}|${r.position_title ?? ''}`;
      if (!map.has(key)) map.set(key, { key, asset: r.asset_name, position: r.position_title ?? '—', items: [] });
      map.get(key)!.items.push(r);
    }
    return [...map.values()];
  }, [rows]);
  const today = new Date().toISOString().slice(0, 10);
  if (!rows.length) return <Empty icon="timeline" />;
  return (
    <div className="gantt" role="table" aria-label={t('rotation.title')}>
      <div className="gantt-grid" style={{ gridTemplateColumns: '220px 1fr' }}>
        <div role="row" style={{ display: 'contents' }}>
        <div className="lane-label head" role="columnheader" />
        <div className="lane head" role="columnheader">
          {weeks.map((w) => (
            <span key={w} style={{ left: pct(w) }}>
              {date(w)}
            </span>
          ))}
        </div>
        </div>
        {lanes.map((l) => {
          // Stack overlapping assignments of the same position (headcount > 1) on separate tracks.
          const tracks: any[][] = [];
          for (const it of [...l.items].sort((a, b) => a.starts_on.localeCompare(b.starts_on))) {
            const tr = tracks.find((x) => x[x.length - 1].ends_on < it.starts_on);
            if (tr) tr.push(it);
            else tracks.push([it]);
          }
          return (
            <div key={l.key} role="row" style={{ display: 'contents' }}>
              <div className="lane-label" role="rowheader" style={{ minHeight: 40 * tracks.length }}>
                <span className="t">{l.position}</span>
                <span className="faint small">{l.asset}</span>
              </div>
              <div className="lane" role="cell" style={{ minHeight: 40 * tracks.length }}>
                {weeks.map((w) => (
                  <span key={w} className="vline" style={{ left: pct(w) }} />
                ))}
                {today >= from && today <= to && <span className="today" style={{ left: pct(today) }} title={t('rotation.today')} />}
                {tracks.map((tr, ti) =>
                  tr.map((it) => {
                    const label = it.full_name ?? t('rotation.uncovered');
                    const style = { left: pct(it.starts_on), width: `calc(${pct(it.ends_on, true)} - ${pct(it.starts_on)})`, top: 8 + ti * 40 };
                    const title = `${label} · ${date(it.starts_on)} – ${date(it.ends_on)}`;
                    return it.personnel_id ? (
                      <Link key={it.id} to={`/personnel/${it.personnel_id}`} className={`bar ${it.status === 'planned' ? 'planned' : ''}`} style={style} title={title}>
                        {label}
                      </Link>
                    ) : (
                      <span key={it.id} className="bar gap" style={style} title={title}>
                        {label}
                      </span>
                    );
                  }),
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Readiness matrix ---------------------------------------------------------------------------- */
const CELL_ICON: Record<string, string> = { valid: 'ok', expiring_soon: 'clock', expires_during: 'clock', pending_verification: 'clock', expired: 'x', missing: 'x', not_met: 'x' };

export function ReadinessMatrix({ rows, requirements }: { rows: any[]; requirements: { id: string; code: string; name_en: string; name_pt: string }[] }) {
  const { t, tk, date, lang } = useI18n();
  if (!rows.length) return <Empty icon="grid" />;
  return (
    <div className="table-wrap">
      <table className="data matrix">
        <caption className="sr-only">{t('readiness.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('common.person')}</th>
            <th scope="col">{t('common.asset')}</th>
            <th scope="col">{t('person.assignments')}</th>
            {requirements.map((r) => (
              <th key={r.id} scope="col" className="req" title={lang === 'en' ? r.name_en : r.name_pt}>
                {r.code}
              </th>
            ))}
            <th scope="col">{t('common.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.assignment_id}>
              <th scope="row" style={{ textAlign: 'left', fontWeight: 550 }}>
                <Link to={`/personnel/${r.personnel_id}`}>{r.full_name}</Link>
                <div className="faint small">{r.position}</div>
              </th>
              <td>{r.asset_name}</td>
              <td className="nowrap small">
                {date(r.starts_on)} – {date(r.ends_on)}
              </td>
              {requirements.map((req) => {
                const c = r.cells.find((x: any) => x.requirementTypeId === req.id);
                return (
                  <td key={req.id} className="cell">
                    {c ? (
                      <span className={`cellchip ${c.status}`} title={c.expiresOn ? `${tk(`status.readiness.${c.status}`)} · ${date(c.expiresOn)}` : tk(`status.readiness.${c.status}`)}>
                        <Icon name={CELL_ICON[c.status]} size={11} />
                        {tk(`status.readiness.${c.status}`)}
                      </span>
                    ) : (
                      <span className="cellchip na" title={t('readiness.notRequired')}>
                        —<span className="sr-only">{t('readiness.notRequired')}</span>
                      </span>
                    )}
                  </td>
                );
              })}
              <td>{r.ready ? <Badge tone="good" icon="ok">{t('readiness.ready')}</Badge> : <Badge tone="critical" icon="alert">{t('readiness.notReady')}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Comments and activity ---------------------------------------------------------------------- */
export function Comments({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { t, dateTime } = useI18n();
  const list = useApi<any[]>(`/api/comments?entityType=${entityType}&entityId=${entityId}`, [entityId]);
  const dir = useApi<any[]>('/api/directory');
  const [body, setBody] = useState('');
  const [dropped, setDropped] = useState(0);
  const { run, busy } = useAction();
  const mentionMatch = body.match(/@([\p{L}]*)$/u);
  const suggestions = mentionMatch && dir.data ? dir.data.filter((u) => u.display_name.toLowerCase().startsWith(mentionMatch[1].toLowerCase())).slice(0, 5) : [];
  const post = async () => {
    const r = await run(() => api('/api/comments', { body: { entityType, entityId, body } }));
    if (r) {
      setBody('');
      setDropped(r.droppedMentions?.length ?? 0);
      list.reload();
    }
  };
  const render = (text: string) => text.replace(/@\[([^\]]+)\]\(user:[0-9a-f-]+\)/g, '@$1');
  return (
    <div className="stack" style={{ gap: 10 }}>
      {list.data?.length ? (
        <ul className="feed">
          {list.data.map((c) => (
            <li key={c.id} className="comment">
              <div className="meta">
                <strong style={{ color: 'var(--text)' }}>{c.author}</strong> · {dateTime(c.created_at)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{render(c.body)}</div>
            </li>
          ))}
        </ul>
      ) : null}
      {dropped > 0 && <Banner tone="warn">{t('comment.droppedMentions', { count: dropped })}</Banner>}
      <div className="field" style={{ position: 'relative' }}>
        <label htmlFor={`c-${entityId}`} className="sr-only">
          {t('comment.placeholder')}
        </label>
        <textarea id={`c-${entityId}`} className="input" rows={3} placeholder={t('comment.placeholder')} value={body} onChange={(e) => setBody(e.target.value)} />
        {suggestions.length > 0 && (
          <div className="popover" style={{ left: 0, right: 'auto', top: '100%' }} role="listbox">
            {suggestions.map((u) => (
              <button key={u.id} className="item" role="option" aria-selected={false} onClick={() => setBody(body.replace(/@[\p{L}]*$/u, `@[${u.display_name}](user:${u.id}) `))}>
                {u.display_name} <span className="faint small">{t(`role.${u.role}` as MessageKey)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <button className="btn" disabled={busy || !body.trim()} onClick={post}>
          {t('comment.post')}
        </button>
      </div>
    </div>
  );
}

export function Activity({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { t, tk, dateTime } = useI18n();
  const s = useApi<any[]>(`/api/activity?entityType=${entityType}&entityId=${entityId}`, [entityId]);
  if (!s.data) return null;
  if (!s.data.length) return <Empty>{t('activity.empty')}</Empty>;
  return (
    <ul className="feed">
      {s.data.map((a, i) => (
        <li key={i} className={a.kind}>
          <div className="meta">
            {dateTime(a.at)} · {a.actor ?? '—'}
          </div>
          <div>
            {a.kind === 'comment' ? <span style={{ whiteSpace: 'pre-wrap' }}>{a.body.replace(/@\[([^\]]+)\]\(user:[0-9a-f-]+\)/g, '@$1')}</span> : tk(`audit.${a.action}`)}
            {a.fields?.length ? <span className="faint small"> · {a.fields.map((f: string) => tk(`req.field.${f.replace('details.', '')}`)).join(', ')}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
