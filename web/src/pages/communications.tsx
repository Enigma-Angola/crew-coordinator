import { Fragment, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { useApi } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Activity, Comments } from '../components/ops';
import { Async, Badge, Banner, Card, Dialog, Empty, Icon, PageHeader, StatusBadge, Tabs, useAction, useToast } from '../components/ui';

type Tab = 'packages' | 'proposals' | 'unmatched';

export function Communications() {
  const { t, tk, dateTime } = useI18n();
  const { can } = useSession();
  const [q, setQ] = useSearchParams();
  const tab = (q.get('tab') as Tab) ?? 'packages';
  const packages = useApi<any[]>('/api/packages');
  const proposals = useApi<any[]>('/api/proposals');
  const unmatched = useApi<any[]>(can('email:associate') ? '/api/messages?status=unmatched' : null);
  const mailboxes = useApi<any[]>('/api/mailboxes');
  const connected = mailboxes.data?.some((m) => m.status === 'connected');
  const { run } = useAction();
  const importEml = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    await run(() => api('/api/messages/import', { form: fd }), t('common.saved'));
    proposals.reload();
    unmatched.reload();
  };
  return (
    <div className="stack">
      <PageHeader
        title={t('comm.title')}
        sub={t('comm.subtitle')}
        actions={
          can('email:associate') && (
            <label className="btn" title={t('comm.importHelp')}>
              <Icon name="upload" /> {t('comm.import')}
              <input type="file" accept=".eml,message/rfc822" hidden onChange={(e) => e.target.files?.[0] && importEml(e.target.files[0])} />
            </label>
          )
        }
      />
      {mailboxes.data && !connected && (
        <Banner tone="warn" icon="info" action={can('mailbox:manage') && <Link className="btn sm" to="/settings/mailboxes">{t('settings.connectMicrosoft')}</Link>}>
          <strong>{t('comm.demoMode')}</strong> — {t('comm.demoModeHelp')}
        </Banner>
      )}
      <Tabs
        label={t('comm.title')}
        value={tab}
        onChange={(v) => setQ({ tab: v })}
        tabs={[
          { id: 'packages', label: t('comm.tab.packages'), count: packages.data?.filter((p) => !['submitted', 'cancelled'].includes(p.status)).length },
          { id: 'proposals', label: t('comm.tab.proposals'), count: proposals.data?.length },
          ...(can('email:associate') ? [{ id: 'unmatched' as Tab, label: t('comm.tab.unmatched'), count: unmatched.data?.length }] : []),
        ]}
      />
      {tab === 'packages' && (
        <div className="card">
          <Async state={packages} empty={(d) => !d.length}>
            {(rows) => (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.reference')}</th>
                      <th>{t('common.supplier')}</th>
                      <th>{t('pkg.subject')}</th>
                      <th>{t('common.status')}</th>
                      <th>{t('req.responseDue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link className="rowlink" to={`/communications/packages/${p.id}`}>
                            {p.reference}
                          </Link>
                          <div className="faint small">
                            {tk(`pkg.purpose.${p.purpose}`)} · {p.crew_change_reference ?? ''} · {t('pkg.requests', { count: p.request_count })}
                          </div>
                        </td>
                        <td>{p.supplier_name}</td>
                        <td className="small">{p.subject}</td>
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <StatusBadge kind="pkg" status={p.status} />
                            {p.blocking && <Badge tone="critical" icon="alert">{t('pkg.warnings')}</Badge>}
                          </div>
                        </td>
                        <td className="small nowrap">
                          {p.status === 'submitted' && p.awaiting_response ? (
                            <span className={new Date(p.response_due_at) < new Date() ? 'badge critical' : 'badge warn'}>{t('comm.responseDue', { when: dateTime(p.response_due_at) })}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Async>
        </div>
      )}
      {tab === 'proposals' && (
        <Async state={proposals} empty={(d) => !d.length}>
          {(rows) => (
            <div className="stack">
              {rows.map((p) => (
                <ProposalCard key={p.id} p={p} onDone={proposals.reload} />
              ))}
            </div>
          )}
        </Async>
      )}
      {tab === 'unmatched' && (
        <div className="card">
          <Async state={unmatched as any} empty={(d: any[]) => !d.length}>
            {(rows: any[]) => (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('msg.from')}</th>
                      <th>{t('pkg.subject')}</th>
                      <th>{t('msg.received')}</th>
                      <th>{t('msg.candidates')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td className="small">{m.from_address}</td>
                        <td>
                          <Link className="rowlink" to={`/communications/messages/${m.id}`}>
                            {m.subject || '—'}
                          </Link>
                          {m.warnings?.map((w: string) => (
                            <div key={w} className="small" style={{ color: 'var(--serious)' }}>
                              {tk(`msg.warning.${w}`)}
                            </div>
                          ))}
                        </td>
                        <td className="small nowrap">{dateTime(m.received_at)}</td>
                        <td className="small">{m.match_candidates?.map((c: any) => c.reference).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Async>
        </div>
      )}
    </div>
  );
}

/* Proposal review ----------------------------------------------------------------------------- */
const RESULT_STATUS: Record<string, string> = { confirmed: 'confirmed', modification: 'confirmed', quotation: 'quoted', proposed: 'proposed', acknowledgement: 'acknowledged', cancellation: 'cancelled' };

export function ProposalCard({ p, onDone, compact }: { p: any; onDone: () => void; compact?: boolean }) {
  const { t, tk, dateTime } = useI18n();
  const items: any[] = p.fields?.items ?? [];
  const [sel, setSel] = useState<string[]>(items.filter((i) => i.changed).map((i) => i.field));
  const canConfirm = p.classification === 'confirmed' || (p.classification === 'modification' && p.fields?.alsoConfirms);
  const defaultStatus = p.classification === 'modification' && !p.fields?.alsoConfirms ? 'unchanged' : RESULT_STATUS[p.classification] ?? 'unchanged';
  const [status, setStatus] = useState(defaultStatus);
  const { run, busy } = useAction();
  const fmt = (f: string, v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v).replace('T', ' '));
  return (
    <Card
      title={
        <span className="row" style={{ gap: 8 }}>
          <Link to={`/requests/${p.request_id}`}>{p.reference}</Link> · {p.full_name} · {tk(`type.${p.type}`)}
        </span>
      }
      question={!compact && `${p.from_address} · ${dateTime(p.received_at)} · ${p.subject ?? ''}`}
      actions={<Badge tone={p.classification === 'acknowledgement' ? 'info' : p.classification === 'cancellation' ? 'critical' : p.classification === 'confirmed' ? 'good' : 'warn'}>{tk(`prop.class.${p.classification}`)}</Badge>}
    >
      <div className="stack" style={{ gap: 10 }}>
        {p.classification === 'acknowledgement' && <Banner tone="info">{t('prop.ackNote')}</Banner>}
        {p.fields?.negatedConfirmation && <Banner tone="warn">{t('prop.negated')}</Banner>}
        {p.fields?.alsoConfirms && <Banner tone="good">{t('prop.alsoConfirms')}</Banner>}
        {p.critical && <p className="small" style={{ color: 'var(--serious)' }}>{t('prop.critical')}</p>}
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                  <th>{t('conflict.field')}</th>
                  <th>{t('prop.current')}</th>
                  <th>{t('prop.proposed')}</th>
                  <th>{t('prop.source')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.field}>
                    <td>
                      <input type="checkbox" aria-label={tk(`req.field.${i.field.replace('details.', '')}`)} checked={sel.includes(i.field)} onChange={(e) => setSel(e.target.checked ? [...sel, i.field] : sel.filter((x) => x !== i.field))} />
                    </td>
                    <td>{tk(`req.field.${i.field.replace('details.', '')}`)}</td>
                    <td className="faint">{fmt(i.field, i.current)}</td>
                    <td>
                      <strong>{fmt(i.field, i.proposed)}</strong>
                    </td>
                    <td className="small">
                      <q style={{ color: 'var(--text-2)' }}>{i.source?.excerpt}</q>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <label className="row small" style={{ gap: 6 }}>
            {t('prop.resultingStatus')}
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="unchanged">{t('prop.unchanged')}</option>
              {['acknowledged', 'quoted', 'proposed', ...(canConfirm ? ['confirmed'] : []), 'cancelled'].map((s) => (
                <option key={s} value={s}>
                  {tk(`status.request.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" style={{ flex: 1 }} />
          <span className="faint small">{t('prop.extractor.rules')}</span>
          <Link className="btn sm ghost" to={`/communications/messages/${p.message_id}`}>
            {t('msg.title')}
          </Link>
          <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/api/proposals/${p.id}/reject`, { body: {} })).then(onDone)}>
            {t('prop.reject')}
          </button>
          <button className="btn sm primary" disabled={busy || (!sel.length && status === 'unchanged')} onClick={() => run(() => api(`/api/proposals/${p.id}/apply`, { body: { fields: sel, resultingStatus: status, version: p.current_version } }), t('common.saved')).then(onDone)}>
            {t('prop.apply')}
          </button>
        </div>
      </div>
    </Card>
  );
}

/* Package review ------------------------------------------------------------------------------ */
export function PackageReview() {
  const { id } = useParams();
  const { t, tk, dateTime, number } = useI18n();
  const { me, can } = useSession();
  const s = useApi<any>(`/api/packages/${id}`, [id]);
  const { run, busy } = useAction();
  const toast = useToast();
  const [external, setExternal] = useState(false);
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    const r = await run(() => api(`/api/packages/${id}/${action}`, { body: { version: s.data.version, ...body } }));
    if (r) {
      if (r.attempt) toast(tk(`status.pkg.${r.attempt === 'failed' ? 'send_failed' : r.attempt === 'uncertain' ? 'send_uncertain' : r.attempt}`));
      s.reload();
    }
  };
  const links = async () => run(() => api(`/api/packages/${id}/links`, { body: {} }));
  const dl = async (kind: 'eml' | string) => {
    const l = await links();
    if (!l) return;
    const url = kind === 'eml' ? l.eml : l.attachments.find((a: any) => a.id === kind)?.url;
    if (url) await download(url);
  };
  return (
    <Async state={s}>
      {(p) => {
        const blocking = p.warnings.filter((w: any) => w.blocking);
        const mine = p.created_by === me?.user.id;
        return (
          <div className="stack">
            <PageHeader
              crumbs={<Link to="/communications">{t('comm.title')}</Link>}
              title={
                <span className="row" style={{ gap: 12 }}>
                  {t('pkg.title', { ref: p.reference })} <StatusBadge kind="pkg" status={p.status} />
                </span>
              }
              sub={`${p.supplier.name} · ${tk(`pkg.purpose.${p.purpose}`)} · ${t('pkg.template', { name: p.template.name, version: p.template.version })}`}
              actions={
                <>
                  <button className="btn" onClick={() => dl('eml')}>
                    <Icon name="download" /> {t('pkg.downloadEml')}
                  </button>
                  {can('email:prepare') && ['draft', 'in_review', 'approved', 'send_failed'].includes(p.status) && (
                    <button className="btn" disabled={busy} onClick={() => act('regenerate')}>
                      <Icon name="refresh" /> {t('pkg.regenerate')}
                    </button>
                  )}
                  {can('email:review') && ['draft', 'in_review'].includes(p.status) && (
                    <button className="btn primary" disabled={busy || p.blocking || p.staleRecords.length > 0 || (p.template.requires_review && mine)} title={p.template.requires_review ? t('pkg.approveHelp') : undefined} onClick={() => act('approve')}>
                      <Icon name="check" /> {t('pkg.approve')}
                    </button>
                  )}
                  {can('email:send') && p.status === 'approved' && !p.demonstrationMode && (
                    <button className="btn primary" disabled={busy} title={t('pkg.sendHelp', { mailbox: p.mailbox?.address })} onClick={() => act('send')}>
                      <Icon name="send" /> {t('pkg.send')}
                    </button>
                  )}
                  {can('email:send') && p.status === 'approved' && (
                    <button className="btn ghost" onClick={() => setExternal(true)}>
                      {t('pkg.recordExternal')}
                    </button>
                  )}
                </>
              }
            />
            {p.demonstrationMode && p.status !== 'submitted' && (
              <Banner tone="warn">
                <strong>{t('comm.demoMode')}</strong> — {t('comm.demoModeHelp')}
              </Banner>
            )}
            {p.staleRecords.length > 0 && <Banner tone="warn">{t('pkg.stale', { refs: p.staleRecords.join(', ') })}</Banner>}
            {p.template.requires_review && mine && ['draft', 'in_review'].includes(p.status) && <Banner tone="info">{t('pkg.approveHelp')}</Banner>}
            {p.status === 'send_failed' && p.last_send_error && <Banner tone="critical">{tk(`status.pkg.send_failed`)} · {p.last_send_error}</Banner>}
            {p.status === 'submitted' && <Banner tone="good">{tk(`pkg.sent.${p.send_channel ?? 'connector'}`)} · {dateTime(p.submitted_at)}</Banner>}

            <div className="grid two">
              <div className="stack">
                <Card title={t('pkg.review')}>
                  <div className="email">
                    <dl className="h">
                      <dt>{t('pkg.sender')}</dt>
                      <dd>{p.mailbox ? `${p.mailbox.address} · ${tk(`status.mailbox.${p.mailbox.status}`)}` : t('pkg.noMailbox')}</dd>
                      <dt>{t('pkg.to')}</dt>
                      <dd>{p.to_addresses.join(', ') || '—'}</dd>
                      <dt>{t('pkg.cc')}</dt>
                      <dd>{p.cc_addresses.join(', ') || '—'}</dd>
                      <dt>{t('pkg.subject')}</dt>
                      <dd>
                        <strong>{p.subject}</strong>
                      </dd>
                      <dt>{t('pkg.language')}</dt>
                      <dd>{tk(`lang.${p.language}`)}</dd>
                    </dl>
                    <pre>{p.body_text}</pre>
                  </div>
                </Card>
                <Card title={t('pkg.attachments')}>
                  <div className="stack" style={{ gap: 8 }}>
                    {p.attachments.length === 0 && <Empty />}
                    {p.attachments.map((a: any) => (
                      <div key={a.id} className={`file ${a.superseded_at ? 'superseded' : ''}`}>
                        <span className="ext" aria-hidden>
                          XLSX
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{a.filename}</div>
                          <div className="faint small">
                            {number(a.size_bytes / 1024, 1)} KB · {a.template_name} · {t('tpl.version', { version: a.template_version })} · {dateTime(a.created_at)}
                            {a.superseded_at && ` · ${t('pkg.superseded')}`}
                          </div>
                        </div>
                        <button className="btn sm" onClick={() => dl(a.id)} aria-label={`${t('pkg.downloadAttachment')}: ${a.filename}`}>
                          <Icon name="download" />
                        </button>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
              <div className="stack">
                <Card title={t('pkg.warnings')}>
                  {p.warnings.length ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {p.warnings.map((w: any, i: number) => (
                        <li key={i} style={{ color: w.blocking ? 'var(--critical)' : 'var(--text-2)' }}>
                          {tk(`warn.${w.code}`, { reference: w.reference, field: w.field ? tk(`req.field.${w.field.replace('details.', '').split(':')[0]}`) : '' })}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{t('pkg.noWarnings')}</p>
                  )}
                  {blocking.length > 0 && <p className="small faint" style={{ marginTop: 8 }}>{t('error.package_has_blocking_warnings')}</p>}
                </Card>
                <Card title={t('pkg.included')}>
                  <ul className="feed">
                    {p.requests.map((r: any) => (
                      <li key={r.id}>
                        <Link to={`/requests/${r.id}`}>{r.reference}</Link> · {r.full_name} <span className="faint small">({r.employee_no})</span>
                        <div>
                          <StatusBadge kind="request" status={r.status} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
                {p.template.provider_instructions && (
                  <Card title={t('pkg.instructions')}>
                    <p className="small">{p.template.provider_instructions}</p>
                  </Card>
                )}
                <Card title={t('pkg.history')}>
                  {p.messages.length ? (
                    <ul className="feed">
                      {p.messages.map((m: any) => (
                        <li key={m.id}>
                          <div className="meta">{dateTime(m.received_at)}</div>
                          <Link to={`/communications/messages/${m.id}`}>{m.subject}</Link>
                          <div className="faint small">
                            {m.from_address} · {tk(`msg.method.${m.match_method}`)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty icon="mail" />
                  )}
                  <div className="faint small" style={{ marginTop: 8 }}>
                    {p.createdByName && t('pkg.preparedBy', { name: p.createdByName })}
                    {p.reviewedByName && ` · ${t('pkg.reviewedBy', { name: p.reviewedByName })}`}
                  </div>
                </Card>
              </div>
            </div>
            <div className="grid halves">
              <Card title={t('task.comments')}>
                <Comments entityType="package" entityId={p.id} />
              </Card>
              <Card title={t('activity.title')}>
                <Activity entityType="package" entityId={p.id} />
              </Card>
            </div>
            {external && (
              <Dialog
                title={t('pkg.recordExternal')}
                onClose={() => setExternal(false)}
                footer={
                  <>
                    <button className="btn" onClick={() => setExternal(false)}>
                      {t('common.cancel')}
                    </button>
                    <button className="btn primary" onClick={() => (setExternal(false), act('record-external-send'))}>
                      {t('common.confirm')}
                    </button>
                  </>
                }
              >
                <p>{t('pkg.recordExternalHelp')}</p>
              </Dialog>
            )}
          </div>
        );
      }}
    </Async>
  );
}

/* Message view -------------------------------------------------------------------------------- */
export function MessageView() {
  const { id } = useParams();
  const { t, tk, dateTime } = useI18n();
  const { can } = useSession();
  const s = useApi<any>(`/api/messages/${id}`, [id]);
  const [linking, setLinking] = useState(false);
  const { run } = useAction();
  const [focusSpan, setFocusSpan] = useState<{ start: number; end: number } | null>(null);
  return (
    <Async state={s}>
      {(m) => {
        const body: string = m.body_text ?? '';
        const marked = focusSpan && !m.bodyRedacted ? [body.slice(0, focusSpan.start), body.slice(focusSpan.start, focusSpan.end), body.slice(focusSpan.end)] : null;
        return (
          <div className="stack">
            <PageHeader
              crumbs={<Link to="/communications">{t('comm.title')}</Link>}
              title={m.subject || t('msg.title')}
              sub={`${m.from_address ?? ''} · ${dateTime(m.received_at)}`}
              actions={
                can('email:associate') && (
                  <>
                    <button className="btn" onClick={() => setLinking(true)}>
                      <Icon name="link" /> {t('msg.linkTo')}
                    </button>
                    {m.match_status === 'unmatched' && (
                      <button className="btn ghost" onClick={() => run(() => api(`/api/messages/${id}/ignore`, { body: {} })).then(s.reload)}>
                        {t('msg.ignore')}
                      </button>
                    )}
                  </>
                )
              }
            />
            <Banner tone="info" icon="shield">
              {t('msg.untrusted')}
            </Banner>
            {m.bodyRedacted && <Banner tone="warn">{t('msg.redacted')}</Banner>}
            {(m.warnings ?? []).map((w: string) => (
              <Banner key={w} tone="warn">
                {tk(`msg.warning.${w}`)}
              </Banner>
            ))}
            <div className="grid two">
              <div className="stack">
                <div className="email">
                  <dl className="h">
                    <dt>{t('msg.from')}</dt>
                    <dd>{m.from_address}</dd>
                    <dt>{t('pkg.to')}</dt>
                    <dd>{m.to_addresses?.join(', ')}</dd>
                    <dt>{t('msg.received')}</dt>
                    <dd>{dateTime(m.received_at)}</dd>
                  </dl>
                  {/* Plain text only: the message is never rendered as HTML. */}
                  <pre>{marked ? <Fragment>{marked[0]}<mark>{marked[1]}</mark>{marked[2]}</Fragment> : body}</pre>
                </div>
                {m.attachments.length > 0 && (
                  <Card title={t('pkg.attachments')}>
                    {m.attachments.map((a: any) => (
                      <div key={a.id} className="file" style={{ marginBottom: 6 }}>
                        <span className="ext" aria-hidden style={{ background: a.mime_type.includes('sheet') ? '#1d6f42' : '#6b5d4f' }}>
                          {a.filename.split('.').pop()?.toUpperCase().slice(0, 4)}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600 }}>{a.filename}</div>
                          <StatusBadge kind="scan" status={a.scan_status} />
                        </div>
                        {a.scan_status === 'clean' && (
                          <button className="btn sm" onClick={async () => { const l = await run(() => api(`/api/attachments/${a.id}/link`, { body: {} })); if (l) await download(l.url); }} aria-label={`${t('common.download')}: ${a.filename}`}>
                            <Icon name="download" />
                          </button>
                        )}
                      </div>
                    ))}
                  </Card>
                )}
              </div>
              <div className="stack">
                <Card title={t('msg.linked')}>
                  {m.requests.length ? (
                    <ul className="feed">
                      {m.requests.map((r: any) => (
                        <li key={r.id}>
                          <Link to={`/requests/${r.id}`}>{r.reference}</Link> · {tk(`type.${r.type}`)}
                          <div className="faint small">
                            {tk(`msg.method.${r.method}`)} · {t('msg.confidence', { value: `${Math.round(Number(r.confidence) * 100)}%` })}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div>
                      <Empty icon="link">{t('msg.unmatchedEmpty')}</Empty>
                      {m.match_candidates?.length > 0 && (
                        <>
                          <h3 style={{ marginTop: 8 }}>{t('msg.candidates')}</h3>
                          <ul>
                            {m.match_candidates.map((c: any, i: number) => (
                              <li key={i} className="small">
                                {c.requestId ? <Link to={`/requests/${c.requestId}`}>{c.reference}</Link> : c.packageId ? <Link to={`/communications/packages/${c.packageId}`}>{c.reference}</Link> : c.reference} · {tk(`msg.method.${c.reason}`)}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </Card>
                {m.proposals
                  .filter((p: any) => p.status === 'pending')
                  .map((p: any) => {
                    const req = m.requests.find((r: any) => r.id === p.request_id);
                    return (
                      <div key={p.id} onMouseOver={(e) => { const q = (e.target as HTMLElement).closest('tr'); const idx = q ? Array.from(q.parentElement!.children).indexOf(q) : -1; const it = p.fields.items?.[idx]; if (it?.source) setFocusSpan({ start: it.source.start, end: it.source.end }); }}>
                        <ProposalCard compact p={{ ...p, reference: req?.reference, full_name: '', type: req?.type, current_version: req?.version, message_id: m.id }} onDone={s.reload} />
                      </div>
                    );
                  })}
                {m.reconciliations.map((r: any) => (
                  <Reconciliation key={r.id} rec={r} onDone={s.reload} />
                ))}
              </div>
            </div>
            {linking && <LinkDialog messageId={m.id} onClose={() => setLinking(false)} onDone={() => (setLinking(false), s.reload())} />}
          </div>
        );
      }}
    </Async>
  );
}

function LinkDialog({ messageId, onClose, onDone }: { messageId: string; onClose: () => void; onDone: () => void }) {
  const { t, tk } = useI18n();
  const [q, setQ] = useState('');
  const reqs = useApi<any[]>('/api/requests?status=requested,acknowledged,quoted,proposed,confirmed,change_pending_review');
  const [sel, setSel] = useState<string[]>([]);
  const { run, busy } = useAction();
  const list = useMemo(() => (reqs.data ?? []).filter((r) => !q || `${r.reference} ${r.person?.full_name} ${r.supplier_name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 60), [reqs.data, q]);
  return (
    <Dialog
      title={t('msg.linkTo')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !sel.length} onClick={() => run(() => api(`/api/messages/${messageId}/link`, { body: { requestIds: sel } })).then((r) => r && onDone())}>
            {t('common.confirm')}
          </button>
        </>
      }
    >
      <input className="input" placeholder={t('common.search')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap" style={{ maxHeight: 360 }}>
        <table className="data">
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  <input type="checkbox" aria-label={r.reference} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />
                </td>
                <td>{r.reference}</td>
                <td>{r.person?.full_name}</td>
                <td>{tk(`type.${r.type}`)}</td>
                <td>{r.supplier_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

function Reconciliation({ rec, onDone }: { rec: any; onDone: () => void }) {
  const { t, tk } = useI18n();
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const { run, busy } = useAction();
  const rows = rec.result.rows as any[];
  const apply = () =>
    run(() =>
      api(`/api/reconciliations/${rec.id}/apply`, {
        body: {
          selections: Object.entries(sel)
            .filter(([, k]) => k.length)
            .map(([requestId, keys]) => ({ requestId, keys, version: rows.find((r) => r.requestId === requestId).requestVersion, ...(override[requestId] ? { conflictsResolvedAs: 'returned' } : {}) })),
        },
      }),
    ).then(onDone);
  const fmt = (v: unknown) => (v === null || v === undefined ? '—' : String(v).replace('T', ' '));
  return (
    <Card title={t('rec.title')} question={`${rec.result.originalFilename} · ${t('rec.help')}`} actions={<StatusBadge kind="pkg" status={rec.status === 'applied' ? 'submitted' : rec.status === 'rejected' ? 'cancelled' : 'in_review'} />}>
      <div className="stack" style={{ gap: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : 0, paddingTop: i ? 10 : 0 }}>
            <div className="row between">
              <strong>{r.reference ?? '—'}</strong>
              <Badge tone={r.status === 'unchanged' ? 'neutral' : r.status === 'conflict' || r.status.startsWith('unknown') || r.status.startsWith('added') ? 'critical' : r.status === 'removed' ? 'serious' : 'warn'}>{tk(`rec.row.${r.status}`)}</Badge>
            </div>
            {r.autoApplied && <p className="small" style={{ color: 'var(--good)' }}>{t('rec.autoApplied')}</p>}
            {r.changes?.length > 0 && (
              <table className="data" style={{ marginTop: 6 }}>
                <thead>
                  <tr>
                    <th />
                    <th>{t('conflict.field')}</th>
                    <th>{t('rec.sent')}</th>
                    <th>{t('rec.returned')}</th>
                    <th>{t('rec.current')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.changes.map((c: any) => (
                    <tr key={c.key}>
                      <td>
                        {c.applicable && !r.autoApplied && rec.status === 'pending' && (
                          <input type="checkbox" aria-label={c.column} checked={(sel[r.requestId] ?? []).includes(c.key)} onChange={(e) => setSel({ ...sel, [r.requestId]: e.target.checked ? [...(sel[r.requestId] ?? []), c.key] : (sel[r.requestId] ?? []).filter((k) => k !== c.key) })} />
                        )}
                      </td>
                      <td>{c.column}</td>
                      <td className="faint">{fmt(c.sent)}</td>
                      <td>
                        <strong>{fmt(c.returned)}</strong>
                      </td>
                      <td style={{ color: c.conflict ? 'var(--critical)' : undefined }}>
                        {fmt(c.current)} {c.conflict && <Icon name="alert" size={12} label={tk('rec.row.conflict')} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {r.status === 'conflict' && rec.status === 'pending' && (
              <label className="check small" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={!!override[r.requestId]} onChange={(e) => setOverride({ ...override, [r.requestId]: e.target.checked })} />
                {t('rec.useReturned')}
              </label>
            )}
          </div>
        ))}
        {rec.status === 'pending' && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/reconciliations/${rec.id}/reject`, { body: {} })).then(onDone)}>
              {t('rec.reject')}
            </button>
            <button className="btn primary" disabled={busy || !Object.values(sel).some((k) => k.length)} onClick={apply}>
              {t('rec.apply')}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
