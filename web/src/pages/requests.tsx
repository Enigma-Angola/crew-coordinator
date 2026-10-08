import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, download } from '../api';
import { useApi, useLiveChanges } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Activity, Comments, RequestStages } from '../components/ops';
import { Async, Banner, Card, ConflictDialog, Dialog, ErrorText, Icon, PageHeader, StatusBadge, type ConflictInfo, useAction, useToast } from '../components/ui';
import { ProposalCard } from './communications';

const TYPES = ['flight', 'hotel', 'transfer', 'medical', 'training', 'immigration'];
const FIELDS: Record<string, { key: string; kind: 'text' | 'date' | 'datetime' }[]> = {
  flight: [{ key: 'from', kind: 'text' }, { key: 'to', kind: 'text' }, { key: 'airline', kind: 'text' }, { key: 'flight_no', kind: 'text' }, { key: 'depart_local', kind: 'datetime' }, { key: 'arrive_local', kind: 'datetime' }, { key: 'cabin', kind: 'text' }],
  hotel: [{ key: 'hotel_name', kind: 'text' }, { key: 'city', kind: 'text' }, { key: 'check_in', kind: 'date' }, { key: 'check_out', kind: 'date' }, { key: 'room_type', kind: 'text' }, { key: 'confirmation_no', kind: 'text' }],
  transfer: [{ key: 'pickup_local', kind: 'datetime' }, { key: 'pickup_location', kind: 'text' }, { key: 'dropoff_location', kind: 'text' }, { key: 'vehicle', kind: 'text' }, { key: 'driver_contact', kind: 'text' }],
  medical: [{ key: 'appointment_local', kind: 'datetime' }, { key: 'clinic', kind: 'text' }, { key: 'exam_type', kind: 'text' }],
  training: [{ key: 'course', kind: 'text' }, { key: 'location', kind: 'text' }, { key: 'starts_on', kind: 'date' }, { key: 'ends_on', kind: 'date' }],
  immigration: [{ key: 'document_type', kind: 'text' }, { key: 'destination_country', kind: 'text' }, { key: 'submission_deadline', kind: 'date' }],
};

export function RequestList() {
  const { t, tk, dateTime } = useI18n();
  const { can } = useSession();
  const [q, setQ] = useSearchParams();
  const type = q.get('type') ?? '';
  const status = q.get('status') ?? '';
  const overdue = q.get('overdue') === '1';
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (overdue) params.set('overdue', '1');
  const s = useApi<any[]>(`/api/requests?${params}`, [params.toString()]);
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(q);
    if (v) n.set(k, v);
    else n.delete(k);
    setQ(n);
  };
  return (
    <div className="stack">
      <PageHeader
        title={t('req.list.title')}
        sub={t('req.list.subtitle')}
        actions={
          <>
            <select className="input" aria-label={t('common.type')} value={type} onChange={(e) => set('type', e.target.value)}>
              <option value="">{t('common.all')}</option>
              {TYPES.map((x) => (
                <option key={x} value={x}>
                  {tk(`type.${x}`)}
                </option>
              ))}
            </select>
            <select className="input" aria-label={t('common.status')} value={status} onChange={(e) => set('status', e.target.value)}>
              <option value="">{t('common.all')}</option>
              {['draft', 'requested', 'acknowledged', 'quoted', 'proposed', 'change_pending_review', 'confirmed', 'completed', 'cancelled'].map((x) => (
                <option key={x} value={x}>
                  {tk(`status.request.${x}`)}
                </option>
              ))}
            </select>
            <label className="check small">
              <input type="checkbox" checked={overdue} onChange={(e) => set('overdue', e.target.checked ? '1' : '')} /> {t('req.overdueOnly')}
            </label>
            {can('export:run') && (
              <button className="btn" onClick={() => download('/api/exports', { method: 'POST', body: { dataset: 'requests', format: 'xlsx' } })}>
                <Icon name="download" /> {t('export.button')}
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
                    <th>{t('common.person')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('common.supplier')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('req.responseDue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link className="rowlink" to={`/requests/${r.id}`}>
                          {r.reference}
                        </Link>
                        <div className="faint small">{r.crew_change_reference}</div>
                      </td>
                      <td>{r.person?.full_name}</td>
                      <td>{tk(`type.${r.type}`)}</td>
                      <td className="nowrap small">{dateTime(r.starts_at, r.location_tz)}</td>
                      <td>{r.supplier_name ?? '—'}</td>
                      <td>
                        <StatusBadge kind="request" status={r.status} />
                      </td>
                      <td className="small nowrap">
                        {r.response_due_at ? <span style={{ color: new Date(r.response_due_at) < new Date() && ['requested', 'acknowledged'].includes(r.status) ? 'var(--critical)' : undefined }}>{dateTime(r.response_due_at)}</span> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </div>
    </div>
  );
}

export function RequestDetail() {
  const { id } = useParams();
  const { t, tk, wall, date, dateTime, money } = useI18n();
  const { me, can } = useSession();
  const s = useApi<any>(`/api/requests/${id}`, [id]);
  const live = useLiveChanges((e) => e.entity === 'request' && e.id === id, me?.user.id);
  const [editing, setEditing] = useState(false);
  const [statusDlg, setStatusDlg] = useState(false);
  const isSupplier = me?.role === 'supplier';
  return (
    <Async state={s}>
      {(r) => {
        const fields = FIELDS[r.type] ?? [];
        return (
          <div className="stack">
            <PageHeader
              crumbs={<Link to="/requests">{t('req.list.title')}</Link>}
              title={
                <span className="row" style={{ gap: 12 }}>
                  {t('req.title', { ref: r.reference })} <StatusBadge kind="request" status={r.status} />
                </span>
              }
              sub={`${tk(`type.${r.type}`)} · ${r.person?.full_name ?? ''}${r.supplier ? ` · ${r.supplier.name}` : ''}`}
              actions={
                <>
                  {can('request:edit') && !['cancelled', 'completed'].includes(r.status) && (
                    <button className="btn" onClick={() => setEditing(true)}>
                      <Icon name="file" /> {t('req.editDetails')}
                    </button>
                  )}
                  {can('request:edit') && (
                    <button className="btn" onClick={() => setStatusDlg(true)}>
                      {t('req.setStatus')}
                    </button>
                  )}
                  {isSupplier && can('request:respond') && <SupplierRespond r={r} onDone={s.reload} />}
                </>
              }
            />
            {live.changedBy && (
              <Banner tone="info" action={<button className="btn sm" onClick={() => (live.clear(), s.reload())}>{t('state.reload')}</button>}>
                {t('state.liveUpdated', { what: r.reference })}
              </Banner>
            )}
            {!isSupplier && (
              <Card title={t('req.timeline')}>
                <RequestStages requestId={r.id} />
              </Card>
            )}
            <div className="grid two">
              <div className="stack">
                <Card title={t('req.details')}>
                  <dl className="kv">
                    {fields.map((f) => (
                      <FragmentRow key={f.key} label={tk(`req.field.${f.key}`)} value={r.details?.[f.key] ? (f.kind === 'datetime' ? wall(r.details[f.key], f.key === 'arrive_local' ? r.details.arrive_tz || r.location_tz : r.location_tz) : f.kind === 'date' ? date(r.details[f.key]) : r.details[f.key]) : '—'} />
                    ))}
                    <FragmentRow label={t('req.bookingRef')} value={r.booking_reference ?? '—'} />
                    {'cost_amount' in r && <FragmentRow label={t('req.cost')} value={r.cost_amount !== null && r.cost_currency ? money(r.cost_amount, r.cost_currency) : '—'} />}
                    <FragmentRow label={t('req.responseDue')} value={r.response_due_at ? dateTime(r.response_due_at) : '—'} />
                  </dl>
                </Card>
                {!isSupplier &&
                  (r.proposals ?? [])
                    .filter((p: any) => p.status === 'pending')
                    .map((p: any) => <ProposalCard key={p.id} compact p={{ ...p, reference: r.reference, full_name: r.person?.full_name, type: r.type, current_version: r.version }} onDone={s.reload} />)}
              </div>
              <div className="stack">
                {r.messages && (
                  <Card title={t('req.messages')}>
                    {r.messages.length ? (
                      <ul className="feed">
                        {r.messages.map((m: any) => (
                          <li key={m.id}>
                            <div className="meta">
                              {dateTime(m.received_at)} · {tk(`msg.method.${m.method}`)}
                            </div>
                            <Link to={`/communications/messages/${m.id}`}>{m.subject}</Link>
                            <div className="faint small">{m.from_address}</div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">—</p>
                    )}
                    {r.packages?.length > 0 && (
                      <div className="row" style={{ marginTop: 8 }}>
                        {r.packages.map((p: any) => (
                          <Link key={p.id} className="badge outline" to={`/communications/packages/${p.id}`}>
                            {p.reference} · {tk(`status.pkg.${p.status}`)}
                          </Link>
                        ))}
                      </div>
                    )}
                  </Card>
                )}
                {!isSupplier && (
                  <>
                    <Card title={t('task.comments')}>
                      <Comments entityType="request" entityId={r.id} />
                    </Card>
                    <Card title={t('activity.title')}>
                      <Activity entityType="request" entityId={r.id} />
                    </Card>
                  </>
                )}
              </div>
            </div>
            {editing && <EditRequest r={r} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), s.reload())} />}
            {statusDlg && <StatusDialog r={r} onClose={() => setStatusDlg(false)} onSaved={() => (setStatusDlg(false), s.reload())} />}
          </div>
        );
      }}
    </Async>
  );
}

function FragmentRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** Field editor with optimistic concurrency: non-overlapping edits merge, overlapping ones open the conflict dialog. */
function EditRequest({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const { t, tk } = useI18n();
  const toast = useToast();
  const fields = FIELDS[r.type] ?? [];
  const initial: Record<string, string> = Object.fromEntries([...fields.map((f) => [`details.${f.key}`, r.details?.[f.key] ?? '']), ['booking_reference', r.booking_reference ?? '']]);
  const [values, setValues] = useState(initial);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = Object.keys(values).filter((k) => values[k] !== initial[k]);
  const save = async (changes: Record<string, unknown>, version: number, base?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api(`/api/requests/${r.id}`, { method: 'PATCH', body: { version, changes, base } });
      if (res.merged) toast(t('conflict.merged'));
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'edit_conflict') setConflict(e.details);
      else if (e instanceof ApiError) toast(<ErrorText error={e} />, 'error');
    } finally {
      setBusy(false);
    }
  };
  const submit = () =>
    save(
      Object.fromEntries(changed.map((k) => [k, values[k] === '' ? null : values[k]])),
      r.version,
      Object.fromEntries(changed.map((k) => [k, initial[k] === '' ? null : initial[k]])),
    );
  if (conflict)
    return (
      <ConflictDialog
        info={conflict}
        labelFor={(f) => tk(`req.field.${f.replace('details.', '')}`)}
        onCancel={() => (setConflict(null), onClose())}
        onResolve={(keep, version) => (Object.keys(keep).length ? save(keep, version) : onSaved())}
      />
    );
  return (
    <Dialog
      title={t('req.editDetails')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !changed.length} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`f-${f.key}`}>
            {tk(`req.field.${f.key}`)} {f.kind === 'datetime' && <span className="faint">({t('req.localTime', { tz: r.location_tz })})</span>}
          </label>
          <input id={`f-${f.key}`} className="input" type={f.kind === 'datetime' ? 'datetime-local' : f.kind === 'date' ? 'date' : 'text'} value={values[`details.${f.key}`]} onChange={(e) => setValues({ ...values, [`details.${f.key}`]: e.target.value })} />
        </div>
      ))}
      <div className="field">
        <label htmlFor="f-booking">{t('req.bookingRef')}</label>
        <input id="f-booking" className="input" value={values.booking_reference} onChange={(e) => setValues({ ...values, booking_reference: e.target.value })} />
      </div>
    </Dialog>
  );
}

function StatusDialog({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const { t, tk } = useI18n();
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const { run, busy } = useAction();
  const inbound = (r.messages ?? []).filter((m: any) => m.direction === 'inbound');
  return (
    <Dialog
      title={t('req.setStatus')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !status || (status === 'confirmed' && !note && !evidence)} onClick={() => run(() => api(`/api/requests/${r.id}/status`, { body: { version: r.version, status, note: note || undefined, evidenceMessageId: evidence || undefined } })).then((x) => x && onSaved())}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="st">{t('common.status')}</label>
        <select id="st" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="" />
          {['requested', 'acknowledged', 'quoted', 'proposed', 'confirmed', 'completed', 'cancelled'].map((x) => (
            <option key={x} value={x}>
              {tk(`status.request.${x}`)}
            </option>
          ))}
        </select>
      </div>
      {inbound.length > 0 && (
        <div className="field">
          <label htmlFor="ev">{t('req.messages')}</label>
          <select id="ev" className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)}>
            <option value="" />
            {inbound.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.subject}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="nt">{t('req.evidenceNote')}</label>
        <textarea id="nt" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}

function SupplierRespond({ r, onDone }: { r: any; onDone: () => void }) {
  const { t } = useI18n();
  const { run, busy } = useAction();
  if (!['requested', 'acknowledged', 'quoted', 'proposed'].includes(r.status)) return null;
  return (
    <>
      <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/requests/${r.id}/respond`, { body: { version: r.version, response: 'acknowledged' } })).then(onDone)}>
        {t('status.request.acknowledged')}
      </button>
      <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/requests/${r.id}/respond`, { body: { version: r.version, response: 'confirmed' } })).then(onDone)}>
        {t('common.confirm')}
      </button>
    </>
  );
}
