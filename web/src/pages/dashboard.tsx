import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { useI18n, type MessageKey } from '../i18n';
import { useSession } from '../session';
import { StackedBars, StackedColumns, type Series, type StackRow } from '../components/charts';
import { InsightList, KpiCard, type Kpi } from '../components/ops';
import { Async, Banner, Card, Dialog, Empty, Loading, PageHeader, StatusBadge } from '../components/ui';

const STATUS_GROUPS: { key: string; statuses: string[]; label: MessageKey; color: string }[] = [
  // Order matches the validated categorical adjacency (slot 1→2→3→4).
  { key: 'draft', statuses: ['draft'], label: 'status.request.draft', color: 'var(--series-1)' },
  { key: 'awaiting', statuses: ['requested', 'acknowledged', 'quoted', 'proposed'], label: 'comm.awaitingResponse', color: 'var(--series-2)' },
  { key: 'confirmed', statuses: ['confirmed', 'completed'], label: 'status.request.confirmed', color: 'var(--series-3)' },
  { key: 'review', statuses: ['change_pending_review'], label: 'status.request.change_pending_review', color: 'var(--series-4)' },
];

export function DrillTable({ rows }: { rows: any[] }) {
  const { t, tk, date, dateTime, money, number } = useI18n();
  if (!rows.length) return <Empty />;
  const entity = rows[0].entity;
  const href = (r: any) =>
    ({ request: `/requests/${r.request_id ?? r.id}`, crew_change: `/crew-changes/${r.id}`, personnel: `/personnel/${r.personnel_id ?? r.id}`, task: `/tasks?focus=${r.id}`, assignment: '/rotation', position: '/rotation', insight: r.crew_change_id ? `/crew-changes/${r.crew_change_id}` : '/', credential: '/' })[entity as string] ?? '/';
  return (
    <div className="table-wrap" style={{ maxHeight: 460 }}>
      <table className="data">
        <thead>
          <tr>
            <th>{t('common.reference')}</th>
            <th>{t('common.person')}</th>
            <th>{t('common.type')}</th>
            <th>{t('common.status')}</th>
            <th>{t('common.date')}</th>
            <th className="num"><span className="sr-only">{t('common.view')}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link className="rowlink" to={href(r)}>
                  {r.reference ?? r.title ?? r.requirement ?? r.position ?? r.asset ?? r.code ?? '—'}
                </Link>
              </td>
              <td>{r.person ?? r.supplier ?? r.asset ?? '—'}</td>
              <td>{r.type ? tk(`type.${r.type}`) : r.kind ? tk(`task.kind.${r.kind}`) : r.requirement ?? '—'}</td>
              <td>
                {entity === 'request' && r.status ? <StatusBadge kind="request" status={r.status} /> : entity === 'crew_change' ? <StatusBadge kind="cc" status="approval_pending" /> : entity === 'task' ? <StatusBadge kind="task" status={r.status} /> : r.expired !== undefined ? (r.expired ? tk('status.readiness.expired') : tk('status.readiness.expiring_soon')) : r.ready !== undefined ? (r.ready ? t('readiness.ready') : t('readiness.notReady')) : r.overdue ? t('req.overdue') : '—'}
              </td>
              <td className="nowrap">{r.starts_at ? dateTime(r.starts_at, r.location_tz) : r.at ? dateTime(r.at) : r.expires_on ? date(r.expires_on) : r.starts_on ? date(r.starts_on) : r.scheduled_on ? date(r.scheduled_on) : r.due_at ? dateTime(r.due_at) : r.response_due_at ? dateTime(r.response_due_at) : '—'}</td>
              <td className="num">{r.cost_amount !== undefined ? money(r.cost_amount, r.cost_currency) : r.hours !== undefined ? `${number(r.hours, 1)} h` : r.required_days !== undefined ? `${number(Math.min(r.covered_days, r.required_days))}/${number(r.required_days)}` : r.total !== undefined ? `${r.done}/${r.total}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drill({ title, url, onClose, expected }: { title: string; url: string; onClose: () => void; expected?: number | null }) {
  const { t } = useI18n();
  const s = useApi<any>(url, [url]);
  const rows = Array.isArray(s.data) ? s.data : s.data?.rows;
  return (
    <Dialog title={title} onClose={onClose} wide>
      <Async state={s}>
        {() => (
          <>
            <p className="small muted">
              {t('dash.drillCount', { count: rows.length })}
              {expected !== undefined && expected !== null && expected !== rows.length && ' ⚠'}
            </p>
            <DrillTable rows={rows} />
          </>
        )}
      </Async>
    </Dialog>
  );
}

export function Dashboard() {
  const { t, tk, relative, date } = useI18n();
  const { me } = useSession();
  const [q, setQ] = useSearchParams();
  const kind = q.get('kind') ?? '';
  const s = useApi<any>(`/api/dashboard${kind ? `?kind=${kind}` : ''}`, [kind]);
  const prefs = useApi<{ hidden?: string[] }>('/api/me/dashboard-preferences');
  const [hidden, setHidden] = useState<string[]>([]);
  const [drill, setDrill] = useState<{ title: string; url: string; expected?: number | null } | null>(null);
  useEffect(() => setHidden(prefs.data?.hidden ?? []), [prefs.data]);
  const saveHidden = (h: string[]) => {
    setHidden(h);
    api('/api/me/dashboard-preferences', { method: 'PUT', body: { hidden: h, order: [] } }).catch(() => undefined);
  };

  const chart = useMemo(() => {
    const rows = s.data?.charts?.requestsByStatus?.rows as { type: string; status: string; n: number }[] | undefined;
    if (!rows) return null;
    const types = [...new Set(rows.map((r) => r.type))];
    const series: Series[] = STATUS_GROUPS.map((g) => ({ key: g.key, label: t(g.label), color: g.color }));
    const data: StackRow[] = types.map((ty) => ({
      key: ty,
      label: tk(`type.${ty}`),
      values: Object.fromEntries(STATUS_GROUPS.map((g) => [g.key, rows.filter((r) => r.type === ty && g.statuses.includes(r.status)).reduce((n, r) => n + r.n, 0)])),
    }));
    return { series, data };
  }, [s.data, t, tk]);

  const weekly = useMemo(() => {
    const rows = s.data?.charts?.crewChangesByWeek?.rows as { week: string; n: number; approved: number }[] | undefined;
    if (!rows?.length) return null;
    return {
      series: [
        { key: 'approved', label: t('dash.chart.approved'), color: 'var(--series-1)' },
        { key: 'pending', label: t('dash.chart.notApproved'), color: 'var(--series-2)' },
      ] as Series[],
      data: rows.map((r) => ({ key: r.week, label: date(r.week).replace(/\s\d{4}$/, ''), values: { approved: r.approved, pending: r.n - r.approved } })),
    };
  }, [s.data, t, date]);

  if (s.loading && !s.data) return <Loading rows={6} />;
  if (s.error) return <Async state={s}>{() => null}</Async>;
  const d = s.data;
  const kpis: Kpi[] = d.kpis;
  const visibleKpis = kpis.filter((k) => !hidden.includes(k.code));

  return (
    <div className="stack">
      <PageHeader
        title={tk(`dash.title.${d.kind}`)}
        sub={
          <>
            {me?.activeOrg?.name} · {t('dash.generated', { when: relative(d.generatedAt) })}
          </>
        }
        actions={
          <>
            {d.available.length > 1 && (
              <div className="seg" role="group" aria-label={t('dash.view')}>
                {d.available.map((k: string) => (
                  <button key={k} aria-pressed={k === d.kind} onClick={() => setQ({ kind: k })}>
                    {tk(`dash.title.${k}`)}
                  </button>
                ))}
              </div>
            )}
            {hidden.length > 0 && (
              <button className="btn" onClick={() => saveHidden([])}>
                {t('dash.restoreCards')}
              </button>
            )}
          </>
        }
      />
      {d.dataFreshness.stale && <Banner tone="warn">{d.dataFreshness.lastMailboxSync ? t('state.stale', { when: relative(d.dataFreshness.lastMailboxSync) }) : t('state.staleNever')}</Banner>}

      <div className="grid kpis">
        {visibleKpis.map((k) => (
          <KpiCard key={k.code} kpi={k} onHide={() => saveHidden([...hidden, k.code])} onDrill={() => setDrill({ title: `${tk(`kpi.${k.code}`)} — ${t('dash.drill')}`, url: `/api/dashboard/kpi/${k.code}`, expected: k.unit === 'count' ? k.value : undefined })} />
        ))}
      </div>

      {(chart || d.exceptions.length > 0 || ['coordination', 'management', 'compliance'].includes(d.kind)) && (
        <div className="grid two">
          <div className="stack">
            {chart && (
              <Card title={t('dash.chart.requests')} question={t('dash.chart.requestsQuestion')} id="chart-requests">
                {chart.data.length ? (
                  <StackedBars
                    rows={chart.data}
                    series={chart.series}
                    caption={t('dash.chart.requests')}
                    rowHeader={t('common.type')}
                    onSelect={(row, ser) => {
                      const g = STATUS_GROUPS.find((x) => x.key === ser.key)!;
                      setDrill({ title: `${row.label} · ${ser.label}`, url: `/api/dashboard/chart/requests-by-status?type=${row.key}&status=${g.statuses.join(',')}`, expected: row.values[ser.key] });
                    }}
                  />
                ) : (
                  <Empty />
                )}
              </Card>
            )}
            {weekly && (
              <Card title={t('dash.chart.crewChanges')} question={t('dash.chart.crewChangesQuestion')} id="chart-weekly">
                <StackedColumns rows={weekly.data} series={weekly.series} caption={t('dash.chart.crewChanges')} rowHeader={t('common.date')} />
              </Card>
            )}
          </div>
          <div className="stack">
            <Card title={t('dash.exceptions')} id="exceptions">
              <InsightList items={d.exceptions} onChanged={s.reload} empty={t('dash.exceptionsEmpty')} />
            </Card>
            {d.predictions.length > 0 && (
              <Card title={t('dash.predictions')} question={t('dash.predictionsHelp')} id="predictions">
                <InsightList items={d.predictions} onChanged={s.reload} />
              </Card>
            )}
          </div>
        </div>
      )}

      {d.kind === 'employee' && <EmployeeItinerary />}
      {d.kind === 'supplier' && <SupplierRequests />}

      {drill && <Drill title={drill.title} url={drill.url} expected={drill.expected} onClose={() => setDrill(null)} />}
    </div>
  );
}

function EmployeeItinerary() {
  const { t, tk, wall, dateTime } = useI18n();
  const s = useApi<any>('/api/dashboard/kpi/my_itinerary');
  return (
    <Card title={t('kpi.my_itinerary')} question={t('kpi.my_itinerary.def')}>
      <Async state={s} empty={(d) => !d.rows.length}>
        {(d) => (
          <ul className="feed">
            {d.rows.map((r: any) => (
              <li key={r.id}>
                <div className="row between">
                  <strong>{tk(`type.${r.type}`)}</strong>
                  <StatusBadge kind="request" status={r.status} />
                </div>
                <div className="muted small">
                  {r.details?.depart_local ? `${r.details.from ?? ''} → ${r.details.to ?? ''} · ${wall(r.details.depart_local, r.location_tz)}` : r.details?.pickup_local ? `${r.details.pickup_location ?? ''} → ${r.details.dropoff_location ?? ''} · ${wall(r.details.pickup_local, r.location_tz)}` : dateTime(r.starts_at, r.location_tz)}
                  {r.details?.hotel_name ? ` · ${r.details.hotel_name}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Card>
  );
}

function SupplierRequests() {
  const { t, tk, dateTime } = useI18n();
  const s = useApi<any[]>('/api/requests?status=requested,acknowledged,quoted,proposed');
  return (
    <Card title={t('kpi.supplier_open_requests')} question={t('kpi.supplier_open_requests.def')}>
      <Async state={s} empty={(d) => !d.length}>
        {(d) => (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.reference')}</th>
                  <th>{t('common.person')}</th>
                  <th>{t('common.type')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('req.responseDue')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {d.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="rowlink" to={`/requests/${r.id}`}>
                        {r.reference}
                      </Link>
                    </td>
                    <td>{r.person?.full_name}</td>
                    <td>{tk(`type.${r.type}`)}</td>
                    <td>{dateTime(r.starts_at, r.location_tz)}</td>
                    <td>{dateTime(r.response_due_at)}</td>
                    <td>
                      <StatusBadge kind="request" status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </Card>
  );
}
