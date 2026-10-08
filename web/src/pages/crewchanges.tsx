import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, download } from '../api';
import { useApi, useLiveChanges } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Activity, Comments, InsightList, MobilisationTimeline } from '../components/ops';
import { Async, Badge, Banner, Card, Dialog, Empty, ErrorText, Icon, PageHeader, Progress, StatusBadge, Tabs, useAction, useToast } from '../components/ui';

export function CrewChangeList() {
  const { t, date } = useI18n();
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const s = useApi<any[]>(`/api/crew-changes${status ? `?status=${status}` : ''}`, [status]);
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <PageHeader
        title={t('cc.list.title')}
        sub={t('cc.list.subtitle')}
        actions={
          <>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
              <option value="">{t('common.all')}</option>
              {['planning', 'approval_pending', 'approved', 'in_progress', 'completed', 'cancelled'].map((x) => (
                <option key={x} value={x}>
                  {t(`status.cc.${x}` as any)}
                </option>
              ))}
            </select>
            {can('crew_change:edit') && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <Icon name="plus" /> {t('cc.new')}
              </button>
            )}
          </>
        }
      />
      <div className="card">
        <Async state={s} empty={(d) => !d.length}>
          {(rows) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('common.reference')}</th>
                    <th>{t('common.asset')}</th>
                    <th>{t('cc.scheduledOn')}</th>
                    <th>{t('common.status')}</th>
                    <th className="num">{t('cc.people')}</th>
                    <th>{t('cc.progress')}</th>
                    <th className="num">{t('cc.issues')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="rowlink" to={`/crew-changes/${c.id}`}>
                          {c.reference}
                        </Link>
                      </td>
                      <td>{c.asset_name}</td>
                      <td className="nowrap">{date(c.scheduled_on)}</td>
                      <td>
                        <StatusBadge kind="cc" status={c.status} />
                      </td>
                      <td className="num">{c.people}</td>
                      <td style={{ minWidth: 160 }}>
                        <Progress value={c.confirmed} max={c.requests} label={t('cc.progressDetail', { done: c.confirmed, total: c.requests })} tone={c.requests && c.confirmed === c.requests ? 'good' : undefined} />
                        <div className="faint small">{t('cc.progressDetail', { done: c.confirmed, total: c.requests })}</div>
                      </td>
                      <td className="num">{c.open_issues ? <Badge tone="critical" icon="alert">{c.open_issues}</Badge> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </div>
      {creating && <NewCrewChange onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewCrewChange({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const assets = useApi<any[]>('/api/assets');
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [f, setF] = useState({ assetId: '', scheduledOn: '', embarkationPoint: '' });
  const submit = async () => {
    const r = await run(() => api('/api/crew-changes', { body: { assetId: f.assetId, scheduledOn: f.scheduledOn, embarkationPoint: f.embarkationPoint || null } }));
    if (r) nav(`/crew-changes/${r.id}`);
  };
  return (
    <Dialog
      title={t('cc.new')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !f.assetId || !f.scheduledOn} onClick={submit}>
            {t('common.create')}
          </button>
        </>
      }
    >
      <p className="muted">{t('cc.newHelp')}</p>
      <div className="field">
        <label htmlFor="cc-asset">{t('common.asset')}</label>
        <select id="cc-asset" className="input" value={f.assetId} onChange={(e) => setF({ ...f, assetId: e.target.value })}>
          <option value="" />
          {assets.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="cc-date">{t('cc.scheduledOn')}</label>
        <input id="cc-date" type="date" className="input" value={f.scheduledOn} onChange={(e) => setF({ ...f, scheduledOn: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="cc-emb">{t('cc.embarkation')}</label>
        <input id="cc-emb" className="input" value={f.embarkationPoint} onChange={(e) => setF({ ...f, embarkationPoint: e.target.value })} />
      </div>
    </Dialog>
  );
}

export function CrewChangeDetail() {
  const { id } = useParams();
  const { t, tk, date, dateTime, wall } = useI18n();
  const { me, can } = useSession();
  const s = useApi<any>(`/api/crew-changes/${id}`, [id]);
  const live = useLiveChanges((e) => (e.entity === 'crew_change' && e.id === id) || e.entity === 'request', me?.user.id);
  const [tab, setTab] = useState<'overview' | 'arrangements' | 'emails' | 'discussion'>('overview');
  const [confirm, setConfirm] = useState<null | 'approve' | 'cancel' | 'generate'>(null);
  const { run, busy } = useAction();
  const toast = useToast();

  const transition = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      await api(`/api/crew-changes/${id}/${action}`, { body: { version: s.data.version, ...extra } });
      setConfirm(null);
      s.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'blockers_present') setConfirm('approve');
      else if (e instanceof ApiError) toast(<ErrorText error={e} />, 'error');
    }
  };

  const prepare = async () => {
    const r = await run(() => api('/api/packages/prepare', { body: { crewChangeId: id } }));
    if (r) {
      const blocked = r.skipped.filter((x: any) => x.blocking).length;
      toast(r.packages.length || blocked ? `${t('pkg.prepared', { count: r.packages.length })}${blocked ? ` · ${t('pkg.skipped', { count: blocked })}` : ''}` : t('pkg.alreadyPrepared'));
      setTab('emails');
      s.reload();
    }
  };

  return (
    <Async state={s}>
      {(cc) => {
        const joining = cc.people.filter((p: any) => p.direction === 'on');
        const active = cc.requests.filter((r: any) => r.status !== 'cancelled');
        const done = active.filter((r: any) => ['confirmed', 'completed'].includes(r.status)).length;
        const critical = cc.insights.filter((i: any) => i.severity === 'critical' && i.status === 'open');
        const selfSubmitted = cc.submitted_by === me?.user.id || cc.created_by === me?.user.id;
        return (
          <div className="stack">
            <PageHeader
              crumbs={<Link to="/crew-changes">{t('cc.list.title')}</Link>}
              title={
                <span className="row" style={{ gap: 12 }}>
                  {cc.reference} <StatusBadge kind="cc" status={cc.status} />
                </span>
              }
              sub={`${cc.asset_name} · ${date(cc.scheduled_on)}${cc.embarkation_point ? ` · ${cc.embarkation_point}` : ''}${cc.embarkation_at ? ` · ${dateTime(cc.embarkation_at, cc.asset_timezone)}` : ''}`}
              actions={
                <>
                  {can('crew_change:edit') && ['planning', 'draft'].includes(cc.status) && (
                    <button className="btn" onClick={() => transition('submit')}>
                      {t('cc.submit')}
                    </button>
                  )}
                  {can('crew_change:approve') && cc.status === 'approval_pending' && (
                    <button className="btn primary" disabled={selfSubmitted} title={selfSubmitted ? t('cc.segregation') : t('cc.approveHelp')} onClick={() => transition('approve')}>
                      <Icon name="check" /> {t('cc.approve')}
                    </button>
                  )}
                  {can('crew_change:edit') && cc.status === 'approved' && (
                    <button className="btn" onClick={() => transition('start')}>
                      {t('cc.start')}
                    </button>
                  )}
                  {can('email:prepare') && (
                    <button className="btn" disabled={busy} onClick={prepare} title={t('cc.prepareHelp')}>
                      <Icon name="mail" /> {t('cc.prepareEmails')}
                    </button>
                  )}
                  {can('export:run') && (
                    <button className="btn ghost" onClick={() => download('/api/exports', { method: 'POST', body: { dataset: 'requests', format: 'xlsx', crewChangeId: id } })}>
                      <Icon name="download" /> {t('export.button')}
                    </button>
                  )}
                  {can('crew_change:cancel') && !['completed', 'cancelled'].includes(cc.status) && (
                    <button className="btn danger" onClick={() => setConfirm('cancel')}>
                      {t('cc.cancel')}
                    </button>
                  )}
                </>
              }
            />
            {live.changedBy && (
              <Banner tone="info" action={<button className="btn sm" onClick={() => (live.clear(), s.reload())}>{t('state.reload')}</button>}>
                {t('state.liveUpdated', { what: cc.reference })}
              </Banner>
            )}
            {cc.status === 'approval_pending' && selfSubmitted && can('crew_change:approve') && <Banner tone="info">{t('cc.segregation')}</Banner>}
            {cc.approved_by && (
              <p className="small muted">
                {t('cc.approvedBy', { name: cc.approved_by_name })} · {dateTime(cc.approved_at)}
              </p>
            )}

            <div className="grid kpis">
              <div className="card kpi" style={{ minHeight: 0 }}>
                <h3 className="label">{t('cc.progress')}</h3>
                <div className="value">{active.length ? Math.round((done / active.length) * 100) : 0}%</div>
                <Progress value={done} max={active.length} label={t('cc.progress')} tone={done === active.length && active.length ? 'good' : undefined} />
                <div className="meta">{t('cc.progressDetail', { done, total: active.length })}</div>
              </div>
              <div className="card kpi" style={{ minHeight: 0 }}>
                <h3 className="label">{t('cc.readiness')}</h3>
                <div className="value">
                  {joining.filter((p: any) => p.ready).length}/{joining.length}
                </div>
                <div className="meta">{t('readiness.summary', { ready: joining.filter((p: any) => p.ready).length, total: joining.length })}</div>
              </div>
              <div className="card kpi" style={{ minHeight: 0 }}>
                <h3 className="label">{t('cc.issues')}</h3>
                <div className="value">{cc.insights.filter((i: any) => i.status === 'open').length}</div>
                <div className="meta">{critical.length ? `${critical.length} ${tk('insight.severity.critical').toLowerCase()}` : t('dash.exceptionsEmpty')}</div>
              </div>
            </div>

            <Tabs
              label={cc.reference}
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'overview', label: t('cc.mobilisation') },
                { id: 'arrangements', label: t('cc.requests'), count: active.length },
                ...(can('email:view') ? [{ id: 'emails' as const, label: t('cc.packages'), count: cc.packages.length }] : []),
                { id: 'discussion', label: t('task.comments') },
              ]}
            />

            {tab === 'overview' && (
              <div className="grid two">
                <div className="stack">
                  <Card title={t('cc.mobilisation')} question={t('cc.mobilisationHelp')}>
                    <MobilisationTimeline people={cc.people} requests={cc.requests} embarkationAt={cc.embarkation_at} />
                  </Card>
                  <Card title={t('cc.people')}>
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>{t('common.person')}</th>
                            <th>{t('common.type')}</th>
                            <th>{t('cc.readiness')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cc.people.map((p: any) => (
                            <tr key={p.id}>
                              <td>
                                <Link className="rowlink" to={`/personnel/${p.personnel_id}`}>
                                  {p.full_name}
                                </Link>
                                <div className="faint small">
                                  {p.employee_no} · {p.job_title}
                                </div>
                              </td>
                              <td>
                                <Badge tone={p.direction === 'on' ? 'info' : 'neutral'}>{tk(`direction.${p.direction}`)}</Badge>
                              </td>
                              <td>
                                {p.direction === 'on' ? (
                                  p.ready ? (
                                    <Badge tone="good" icon="ok">
                                      {t('readiness.ready')}
                                    </Badge>
                                  ) : (
                                    <span className="row" style={{ gap: 4 }}>
                                      <Badge tone="critical" icon="alert">
                                        {t('readiness.notReady')}
                                      </Badge>
                                      {(p.readiness ?? [])
                                        .filter((c: any) => !['valid', 'expiring_soon'].includes(c.status))
                                        .map((c: any) => (
                                          <span key={c.requirementTypeId} className={`cellchip ${c.status}`}>
                                            {tk(`status.readiness.${c.status}`)}
                                          </span>
                                        ))}
                                    </span>
                                  )
                                ) : (
                                  '—'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </div>
                <Card title={t('dash.exceptions')}>
                  <InsightList items={cc.insights.filter((i: any) => i.status === 'open')} onChanged={s.reload} empty={t('dash.exceptionsEmpty')} />
                </Card>
              </div>
            )}

            {tab === 'arrangements' && (
              <Card
                title={t('cc.requests')}
                actions={
                  can('request:edit') && (
                    <button className="btn" onClick={() => setConfirm('generate')}>
                      <Icon name="plus" /> {t('cc.generateRequests')}
                    </button>
                  )
                }
              >
                {cc.requests.length ? (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>{t('common.reference')}</th>
                          <th>{t('common.person')}</th>
                          <th>{t('common.type')}</th>
                          <th>{t('req.details')}</th>
                          <th>{t('common.supplier')}</th>
                          <th>{t('common.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cc.requests.map((r: any) => {
                          const person = cc.people.find((p: any) => p.personnel_id === r.personnel_id);
                          const d = r.details ?? {};
                          const when = d.depart_local ?? d.pickup_local ?? d.appointment_local;
                          return (
                            <tr key={r.id}>
                              <td>
                                <Link className="rowlink" to={`/requests/${r.id}`}>
                                  {r.reference}
                                </Link>
                              </td>
                              <td>{person?.full_name}</td>
                              <td>{tk(`type.${r.type}`)}</td>
                              <td className="small">
                                {[d.flight_no, d.from && d.to ? `${d.from}→${d.to}` : null, d.hotel_name, d.pickup_location, d.clinic, d.course].filter(Boolean).join(' · ')}
                                {when && <div className="faint">{wall(when, r.location_tz)}</div>}
                                {d.check_in && (
                                  <div className="faint">
                                    {date(d.check_in)} – {date(d.check_out)}
                                  </div>
                                )}
                              </td>
                              <td>{r.supplier_name ?? '—'}</td>
                              <td>
                                <StatusBadge kind="request" status={r.status} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty />
                )}
              </Card>
            )}

            {tab === 'emails' && (
              <Card title={t('cc.packages')} question={t('cc.prepareHelp')}>
                {cc.packages.length ? (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>{t('common.reference')}</th>
                          <th>{t('common.supplier')}</th>
                          <th>{t('pkg.subject')}</th>
                          <th>{t('common.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cc.packages.map((p: any) => (
                          <tr key={p.id}>
                            <td>
                              <Link className="rowlink" to={`/communications/packages/${p.id}`}>
                                {p.reference}
                              </Link>
                              <div className="faint small">{tk(`pkg.purpose.${p.purpose}`)}</div>
                            </td>
                            <td>{p.supplier_name}</td>
                            <td className="small">{p.subject}</td>
                            <td>
                              <StatusBadge kind="pkg" status={p.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty>{t('comm.noPackages')}</Empty>
                )}
              </Card>
            )}

            {tab === 'discussion' && (
              <div className="grid halves">
                <Card title={t('task.comments')}>
                  <Comments entityType="crew_change" entityId={cc.id} />
                </Card>
                <Card title={t('activity.title')}>
                  <Activity entityType="crew_change" entityId={cc.id} />
                </Card>
              </div>
            )}

            {confirm === 'approve' && (
              <Dialog
                title={t('cc.approve')}
                onClose={() => setConfirm(null)}
                footer={
                  <>
                    <button className="btn" onClick={() => setConfirm(null)}>
                      {t('common.cancel')}
                    </button>
                    <button className="btn primary" onClick={() => transition('approve', { acknowledgeBlockers: true })}>
                      {t('cc.approve')}
                    </button>
                  </>
                }
              >
                <Banner tone="critical">{t('cc.approveBlockers')}</Banner>
                <InsightList items={critical} />
                <p className="small muted">{t('cc.approveHelp')}</p>
              </Dialog>
            )}
            {confirm === 'cancel' && <CancelDialog onClose={() => setConfirm(null)} onConfirm={(reason) => transition('cancel', { reason })} />}
            {confirm === 'generate' && <GenerateDialog crewChangeId={cc.id} onClose={() => setConfirm(null)} onDone={() => (setConfirm(null), s.reload())} />}
          </div>
        );
      }}
    </Async>
  );
}

function CancelDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      title={t('cc.cancel')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn danger" disabled={!reason.trim()} onClick={() => onConfirm(reason)}>
            {t('common.confirm')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="cancel-reason">{t('cc.cancelReason')}</label>
        <textarea id="cancel-reason" className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

function GenerateDialog({ crewChangeId, onClose, onDone }: { crewChangeId: string; onClose: () => void; onDone: () => void }) {
  const { t, tk } = useI18n();
  const suppliers = useApi<any[]>('/api/suppliers');
  const [types, setTypes] = useState<string[]>(['flight', 'hotel', 'transfer']);
  const [sup, setSup] = useState<Record<string, string>>({});
  const { run, busy } = useAction();
  const byCat: Record<string, string> = { flight: 'travel', hotel: 'hotel', transfer: 'transport', medical: 'medical', training: 'training', immigration: 'immigration' };
  return (
    <Dialog
      title={t('cc.generateRequests')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !types.length} onClick={() => run(() => api(`/api/crew-changes/${crewChangeId}/requests/generate`, { body: { types, suppliers: sup } })).then((r) => r && onDone())}>
            {t('common.create')}
          </button>
        </>
      }
    >
      <p className="muted">{t('cc.generateHelp')}</p>
      {Object.keys(byCat).map((ty) => (
        <div key={ty} className="row" style={{ gap: 12 }}>
          <label className="check" style={{ width: 200 }}>
            <input type="checkbox" checked={types.includes(ty)} onChange={(e) => setTypes(e.target.checked ? [...types, ty] : types.filter((x) => x !== ty))} />
            {tk(`type.${ty}`)}
          </label>
          <select className="input" aria-label={`${tk(`type.${ty}`)} — ${t('common.supplier')}`} disabled={!types.includes(ty)} value={sup[ty] ?? ''} onChange={(e) => setSup({ ...sup, [ty]: e.target.value })}>
            <option value="">—</option>
            {suppliers.data?.filter((s) => s.category === byCat[ty]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ))}
    </Dialog>
  );
}
