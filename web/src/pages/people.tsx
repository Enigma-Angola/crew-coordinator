import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download } from '../api';
import { useApi } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Activity, ReadinessMatrix, RotationTimeline } from '../components/ops';
import { Async, Badge, Banner, Card, Dialog, Empty, Icon, PageHeader, StatusBadge, useAction } from '../components/ui';

export function PersonnelList() {
  const { t, tk } = useI18n();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const s = useApi<any>(`/api/personnel?q=${encodeURIComponent(q)}`, [q]);
  return (
    <div className="stack">
      <PageHeader
        title={t('person.title')}
        sub={t('person.subtitle')}
        actions={
          <>
            <input className="input" type="search" placeholder={t('common.search')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            {can('personnel:import') && (
              <button className="btn" onClick={() => setImporting(true)}>
                <Icon name="upload" /> {t('person.import')}
              </button>
            )}
            {can('export:run') && (
              <button className="btn" onClick={() => download('/api/exports', { method: 'POST', body: { dataset: 'personnel', format: 'xlsx' } })}>
                <Icon name="download" /> {t('export.button')}
              </button>
            )}
          </>
        }
      />
      <div className="card">
        <Async state={s} empty={(d) => !d.rows.length}>
          {(d) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('common.name')}</th>
                    <th>{t('person.employeeNo')}</th>
                    <th>{t('person.jobTitle')}</th>
                    <th>{t('person.nationality')}</th>
                    <th>{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((p: any) => (
                    <tr key={p.id}>
                      <td>
                        <Link className="rowlink" to={`/personnel/${p.id}`}>
                          {p.full_name}
                        </Link>
                      </td>
                      <td className="mono">{p.employee_no}</td>
                      <td>{p.job_title}</td>
                      <td>{p.nationality}</td>
                      <td>
                        <Badge tone={p.status === 'active' ? 'good' : p.status === 'onboarding' ? 'info' : 'neutral'}>{tk(`person.status.${p.status}`)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="faint small" style={{ padding: '8px 12px' }}>
                {t('common.records', { count: d.total })}
              </p>
            </div>
          )}
        </Async>
      </div>
      {importing && <ImportDialog onClose={() => (setImporting(false), s.reload())} />}
    </div>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t, tk } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<any>(null);
  const { run, busy } = useAction();
  const send = async (dryRun: boolean) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const r = await run(() => api(`/api/personnel/import?dryRun=${dryRun ? 1 : 0}`, { form: fd }), dryRun ? undefined : t('person.importDone'));
    if (r) {
      setReport(r);
      if (!dryRun) onClose();
    }
  };
  const valid = report ? report.summary.create + report.summary.update : 0;
  return (
    <Dialog
      title={t('person.import')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {report?.dryRun && valid > 0 && (
            <button className="btn primary" disabled={busy} onClick={() => send(false)}>
              {t('person.importCommit', { count: valid })}
            </button>
          )}
        </>
      }
    >
      <p className="muted">{t('person.importHelp')}</p>
      <div className="row">
        <input type="file" accept=".csv,.xlsx" aria-label={t('person.import')} onChange={(e) => (setFile(e.target.files?.[0] ?? null), setReport(null))} />
        <button className="btn" disabled={!file || busy} onClick={() => send(true)}>
          {t('common.view')}
        </button>
      </div>
      {report && (
        <>
          <Banner tone={report.summary.errors ? 'warn' : 'good'}>{t('person.importPreview', report.summary)}</Banner>
          <div className="table-wrap" style={{ maxHeight: 340 }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>{t('person.employeeNo')}</th>
                  <th>{t('common.name')}</th>
                  <th>{t('common.actions')}</th>
                  <th>{t('common.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r: any) => (
                  <tr key={r.row}>
                    <td className="num">{r.row}</td>
                    <td className="mono">{r.employeeNo ?? '—'}</td>
                    <td>{r.fullName ?? '—'}</td>
                    <td>
                      <Badge tone={r.action === 'error' ? 'critical' : r.action === 'create' ? 'good' : r.action === 'update' ? 'info' : 'neutral'}>{tk(`person.importAction.${r.action}`)}</Badge>
                    </td>
                    <td className="small">{r.errors.length ? r.errors.map((e: string) => tk(`import.error.${e}`)).join(', ') : r.changedFields.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function PersonnelDetail() {
  const { id } = useParams();
  const { t, tk, date, dateTime, lang, number } = useI18n();
  const { can, me } = useSession();
  const s = useApi<any>(`/api/personnel/${id}`, [id]);
  const { run, busy } = useAction();
  const [upload, setUpload] = useState(false);
  const isSelf = me?.personnelId === id;
  const verify = (c: any, outcome: 'verified' | 'rejected') => run(() => api(`/api/credentials/${c.id}/verify`, { body: { outcome, version: c.version } })).then(s.reload);
  const openDoc = async (docId: string) => {
    const l = await run(() => api(`/api/documents/${docId}/link`, { body: {} }));
    if (l) await download(l.url);
  };
  return (
    <Async state={s}>
      {(p) => (
        <div className="stack">
          <PageHeader
            crumbs={can('personnel:view') && me?.role !== 'employee' ? <Link to="/personnel">{t('person.title')}</Link> : undefined}
            title={p.full_name}
            sub={`${p.employee_no} · ${p.job_title ?? ''} · ${p.employer ?? ''}`}
            actions={
              (can('documents:upload') || isSelf) && (
                <button className="btn" onClick={() => setUpload(true)}>
                  <Icon name="upload" /> {t('person.uploadDoc')}
                </button>
              )
            }
          />
          <div className="grid two">
            <div className="stack">
              <Card title={t('person.assignments')}>
                {p.assignments.length ? (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>{t('common.asset')}</th>
                          <th>{t('common.position')}</th>
                          <th>{t('common.date')}</th>
                          <th>{t('cc.readiness')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.assignments.map((a: any) => (
                          <tr key={a.id}>
                            <td>{a.asset_name}</td>
                            <td>{a.position_title ?? '—'}</td>
                            <td className="nowrap small">
                              {date(a.starts_on)} – {date(a.ends_on)}
                            </td>
                            <td>
                              {a.readiness ? (
                                <span className="row" style={{ gap: 4 }}>
                                  {a.readiness.map((c: any) => {
                                    const rt = p.credentials.find((x: any) => x.requirement_type_id === c.requirementTypeId);
                                    return (
                                      <span key={c.requirementTypeId} className={`cellchip ${c.status}`} title={tk(`status.readiness.${c.status}`)}>
                                        {rt?.code ?? ''} · {tk(`status.readiness.${c.status}`)}
                                      </span>
                                    );
                                  })}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty>{t('person.noAssignments')}</Empty>
                )}
              </Card>
              <Card title={t('person.credentials')}>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>{t('common.type')}</th>
                        <th>{t('req.field.ends_on')}</th>
                        <th>{t('common.status')}</th>
                        <th>
                          <span className="sr-only">{t('common.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.credentials.map((c: any) => (
                        <tr key={c.id}>
                          <td>
                            <strong>{c.code}</strong>
                            <div className="faint small">{lang === 'en' ? c.name_en : c.name_pt}</div>
                          </td>
                          <td className="nowrap">{c.expires_on ? date(c.expires_on) : '—'}</td>
                          <td>
                            <StatusBadge kind="readiness" status={c.verification_status === 'pending' ? 'pending_verification' : c.verification_status === 'rejected' ? 'missing' : c.expires_on && c.expires_on < new Date().toISOString().slice(0, 10) ? 'expired' : 'valid'} />
                          </td>
                          <td className="right">
                            {can('credentials:verify') && c.verification_status === 'pending' && (
                              <span className="row" style={{ justifyContent: 'flex-end' }}>
                                <button className="btn sm" disabled={busy} onClick={() => verify(c, 'verified')}>
                                  {t('person.verify')}
                                </button>
                                <button className="btn sm ghost" disabled={busy} onClick={() => verify(c, 'rejected')}>
                                  {t('person.rejectCredential')}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card title={t('person.documents')}>
                {p.documents.length ? (
                  p.documents.map((d: any) => (
                    <div key={d.id} className="file" style={{ marginBottom: 6 }}>
                      <span className="ext" aria-hidden style={{ background: d.classification === 'medical' ? '#8a3d3d' : d.classification === 'identity' ? '#3d4f8a' : '#6b5d4f' }}>
                        {d.mime_type.split('/')[1].slice(0, 4).toUpperCase()}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{d.filename}</div>
                        <div className="faint small">
                          {tk(`person.classification.${d.classification}`)} · {number(d.size_bytes / 1024, 1)} KB · {dateTime(d.uploaded_at)}
                        </div>
                      </div>
                      <StatusBadge kind="scan" status={d.scan_status} />
                      {d.scan_status === 'clean' && (
                        <button className="btn sm" onClick={() => openDoc(d.id)} aria-label={`${t('common.download')}: ${d.filename}`}>
                          <Icon name="download" />
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <Empty />
                )}
              </Card>
            </div>
            <div className="stack">
              <Card title={t('req.details')}>
                <dl className="kv">
                  <dt>{t('person.email')}</dt>
                  <dd>{p.email ?? '—'}</dd>
                  <dt>{t('person.phone')}</dt>
                  <dd>{p.phone ?? '—'}</dd>
                  <dt>{t('person.nationality')}</dt>
                  <dd>{p.nationality ?? '—'}</dd>
                  <dt>{t('person.homeBase')}</dt>
                  <dd>{p.home_base ?? '—'}</dd>
                  <dt>{t('common.status')}</dt>
                  <dd>{tk(`person.status.${p.status}`)}</dd>
                </dl>
              </Card>
              <Card title={t('person.identity')} actions={<Icon name="lock" label={t('common.restricted')} />}>
                {p.identity?.restricted ? (
                  <p className="muted">{t('common.restrictedHelp')}</p>
                ) : p.identity ? (
                  <dl className="kv">
                    <dt>{t('person.passport')}</dt>
                    <dd className="mono">{p.identity.passport_number ?? '—'}</dd>
                    <dt>{t('person.passportExpiry')}</dt>
                    <dd>{date(p.identity.passport_expiry)}</dd>
                    <dt>{t('person.dob')}</dt>
                    <dd>{date(p.identity.date_of_birth)}</dd>
                    <dt>{t('person.visa')}</dt>
                    <dd>{p.identity.visa_type ? `${p.identity.visa_type} · ${date(p.identity.visa_expiry)}` : '—'}</dd>
                  </dl>
                ) : (
                  <Empty />
                )}
              </Card>
              <Card title={t('person.medical')} actions={<Icon name="lock" label={t('common.restricted')} />}>
                {p.medical?.restricted ? (
                  <p className="muted">{t('common.restrictedHelp')}</p>
                ) : p.medical ? (
                  <>
                    <dl className="kv">
                      <dt>{t('common.status')}</dt>
                      <dd>{p.medical.fitness_status ? tk(`person.fitness.${p.medical.fitness_status}`) : '—'}</dd>
                      <dt>{t('req.field.ends_on')}</dt>
                      <dd>{date(p.medical.expires_on)}</dd>
                      <dt>{t('req.field.clinic')}</dt>
                      <dd>{p.medical.provider_name ?? '—'}</dd>
                      {p.medical.restrictions && (
                        <>
                          <dt>{t('common.notes')}</dt>
                          <dd>{p.medical.restrictions}</dd>
                        </>
                      )}
                    </dl>
                    <p className="faint small" style={{ marginTop: 8 }}>
                      {t('person.medicalNote')}
                    </p>
                  </>
                ) : (
                  <Empty />
                )}
              </Card>
              {me?.role !== 'employee' && (
                <Card title={t('activity.title')}>
                  <Activity entityType="personnel" entityId={p.id} />
                </Card>
              )}
            </div>
          </div>
          {upload && <UploadDialog personnelId={p.id} onClose={() => (setUpload(false), s.reload())} />}
        </div>
      )}
    </Async>
  );
}

function UploadDialog({ personnelId, onClose }: { personnelId: string; onClose: () => void }) {
  const { t, tk } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [cls, setCls] = useState('general');
  const { run, busy } = useAction();
  const send = async () => {
    if (!file) return;
    const fd = new FormData();
    fd.append('classification', cls);
    fd.append('file', file);
    const r = await run(() => api(`/api/personnel/${personnelId}/documents`, { form: fd }), t('common.saved'));
    if (r) onClose();
  };
  return (
    <Dialog
      title={t('person.uploadDoc')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!file || busy} onClick={send}>
            {t('common.upload')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="doc-class">{t('common.type')}</label>
        <select id="doc-class" className="input" value={cls} onChange={(e) => setCls(e.target.value)}>
          {['general', 'identity', 'medical'].map((c) => (
            <option key={c} value={c}>
              {tk(`person.classification.${c}`)}
            </option>
          ))}
        </select>
      </div>
      <input type="file" accept="application/pdf,image/png,image/jpeg" aria-label={t('person.uploadDoc')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <p className="small faint">{t('status.scan.quarantined')}</p>
    </Dialog>
  );
}

export function Readiness() {
  const { t } = useI18n();
  const assets = useApi<any[]>('/api/assets');
  const [asset, setAsset] = useState('');
  const s = useApi<any>(`/api/readiness?days=60${asset ? `&assetId=${asset}` : ''}`, [asset]);
  return (
    <div className="stack">
      <PageHeader
        title={t('readiness.title')}
        sub={t('readiness.subtitle', { days: 60 })}
        actions={
          <select className="input" aria-label={t('common.asset')} value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {assets.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        }
      />
      <div className="card">
        <Async state={s}>
          {(d) => (
            <>
              <p className="small muted" style={{ padding: '12px 16px 0' }}>
                {t('readiness.summary', { ready: d.rows.filter((r: any) => r.ready).length, total: d.rows.length })}
              </p>
              <ReadinessMatrix rows={d.rows} requirements={d.requirements} />
            </>
          )}
        </Async>
      </div>
    </div>
  );
}

export function Rotation() {
  const { t } = useI18n();
  const today = new Date();
  const from = new Date(today.getTime() - 14 * 86400_000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 56 * 86400_000).toISOString().slice(0, 10);
  const assets = useApi<any[]>('/api/assets');
  const [asset, setAsset] = useState('');
  const s = useApi<any>(`/api/rotation?from=${from}&to=${to}${asset ? `&assetId=${asset}` : ''}`, [asset]);
  return (
    <div className="stack">
      <PageHeader
        title={t('rotation.title')}
        sub={t('rotation.subtitle')}
        actions={
          <select className="input" aria-label={t('common.asset')} value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {assets.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        }
      />
      <Async state={s}>{(d) => <RotationTimeline rows={d.rows} from={d.from} to={d.to} />}</Async>
      <div className="legend">
        <span>
          <span className="swatch current" />
          {t('rotation.current')}
        </span>
        <span>
          <span className="swatch planned" />
          {t('rotation.planned')}
        </span>
        <span>
          <span className="key" style={{ background: 'var(--critical-soft)', border: '1px dashed var(--mark-critical)' }} />
          {t('rotation.uncovered')}
        </span>
        <span>
          <span className="key" style={{ background: 'var(--mark-critical)', width: 3 }} />
          {t('rotation.today')}
        </span>
      </div>
    </div>
  );
}
