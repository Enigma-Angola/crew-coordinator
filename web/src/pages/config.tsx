import { useState } from 'react';
import { api } from '../api';
import { useApi } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Async, Badge, Banner, Card, Dialog, Empty, Icon, PageHeader, Tabs, useAction } from '../components/ui';

export function Suppliers() {
  const { t, tk } = useI18n();
  const { can } = useSession();
  const s = useApi<any[]>('/api/suppliers');
  const { run, busy } = useAction();
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <div className="stack">
      <PageHeader title={t('sup.title')} />
      <Async state={s} empty={(d) => !d.length}>
        {(rows) => (
          <div className="grid halves">
            {rows.map((sup) => (
              <Card
                key={sup.id}
                title={sup.name}
                question={`${tk(`sup.category.${sup.category}`)} · ${tk(`lang.${sup.default_language}`)}`}
                actions={
                  <>
                    {sup.trusted_structured_updates && <Badge tone="info">{t('sup.trusted')}</Badge>}
                    {can('supplier:manage') && (
                      <button className="btn sm" onClick={() => setAdding(sup.id)}>
                        <Icon name="plus" /> {t('sup.addContact')}
                      </button>
                    )}
                  </>
                }
              >
                <h3 className="small muted" style={{ marginBottom: 6 }}>
                  {t('sup.contacts')}
                </h3>
                {sup.contacts.length ? (
                  <ul className="feed">
                    {sup.contacts.map((c: any) => (
                      <li key={c.id}>
                        <div className="row between">
                          <span>
                            <strong>{c.name}</strong> · {c.email} <span className="faint small">({c.role.toUpperCase()})</span>
                          </span>
                          {c.verified ? (
                            <Badge tone="good" icon="ok">
                              {t('sup.verified')}
                            </Badge>
                          ) : (
                            <span className="row" style={{ gap: 4 }}>
                              <Badge tone="warn" icon="alert">
                                {t('sup.unverified')}
                              </Badge>
                              {can('supplier:manage') && (
                                <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/api/supplier-contacts/${c.id}/verify`, { body: {} })).then(s.reload)}>
                                  {t('sup.verify')}
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty icon="mail" />
                )}
              </Card>
            ))}
          </div>
        )}
      </Async>
      {adding && <AddContact supplierId={adding} onClose={() => (setAdding(null), s.reload())} />}
    </div>
  );
}

function AddContact({ supplierId, onClose }: { supplierId: string; onClose: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', email: '', role: 'to' });
  const { run, busy } = useAction();
  return (
    <Dialog
      title={t('sup.addContact')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !f.name || !f.email} onClick={() => run(() => api(`/api/suppliers/${supplierId}/contacts`, { body: f }), t('common.saved')).then((r) => r && onClose())}>
            {t('common.add')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="c-name">{t('common.name')}</label>
        <input id="c-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="c-email">{t('person.email')}</label>
        <input id="c-email" type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="c-role">{t('tpl.recipients')}</label>
        <select id="c-role" className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="to">{t('pkg.to')}</option>
          <option value="cc">{t('pkg.cc')}</option>
        </select>
      </div>
      <Banner tone="info">{t('sup.unverified')}</Banner>
    </Dialog>
  );
}

export function Templates() {
  const { t, tk, dateTime } = useI18n();
  const { can } = useSession();
  const [tab, setTab] = useState<'email' | 'workbook'>('email');
  const emails = useApi<any[]>('/api/email-templates');
  const books = useApi<any[]>('/api/workbook-templates');
  const { run, busy } = useAction();
  const upload = async (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    await run(() => api(`/api/workbook-templates/${id}/base-file`, { form: fd }));
    books.reload();
  };
  return (
    <div className="stack">
      <PageHeader title={t('tpl.title')} />
      <Tabs label={t('tpl.title')} value={tab} onChange={setTab} tabs={[{ id: 'email', label: t('tpl.email') }, { id: 'workbook', label: t('tpl.workbook') }]} />
      {tab === 'email' && (
        <Async state={emails} empty={(d) => !d.length}>
          {(rows) => (
            <div className="grid halves">
              {rows
                .filter((r) => r.status === 'active')
                .map((r) => (
                  <Card key={r.id} title={r.name} question={`${r.supplier_name} · ${tk(`type.${r.request_type}`)} · ${tk(`lang.${r.language}`)} · ${t('tpl.version', { version: r.version })}`}>
                    <dl className="kv">
                      <dt>{t('pkg.subject')}</dt>
                      <dd className="mono">{r.subject_format}</dd>
                      <dt>{t('tpl.filename')}</dt>
                      <dd className="mono">{r.filename_convention}</dd>
                      <dt>{t('tpl.review')}</dt>
                      <dd>{r.requires_review ? t('tpl.reviewRequired') : t('tpl.reviewOptional')}</dd>
                      <dt>{t('req.responseDue')}</dt>
                      <dd>{t('kpi.unit.hours', { value: r.response_hours })}</dd>
                      {r.automation_allowed && (
                        <>
                          <dt>{t('tpl.automation')}</dt>
                          <dd>{t('common.yes')}</dd>
                        </>
                      )}
                    </dl>
                    <details style={{ marginTop: 8 }}>
                      <summary className="small muted">{t('pkg.body')}</summary>
                      <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
                        {r.body_template}
                      </pre>
                    </details>
                  </Card>
                ))}
            </div>
          )}
        </Async>
      )}
      {tab === 'workbook' && (
        <Async state={books} empty={(d) => !d.length}>
          {(rows) => (
            <div className="stack">
              {rows
                .filter((r) => r.status === 'active')
                .map((r) => (
                  <Card
                    key={r.id}
                    title={r.name}
                    question={`${t('tpl.version', { version: r.version })} · ${dateTime(r.created_at)}`}
                    actions={
                      can('template:manage') && (
                        <label className="btn sm">
                          <Icon name="upload" /> {t('tpl.uploadBase')}
                          <input type="file" accept=".xlsx" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && upload(r.id, e.target.files[0])} />
                        </label>
                      )
                    }
                  >
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>{t('tpl.columns')}</th>
                            <th>{t('common.type')}</th>
                            <th>{t('common.required')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.definition.columns.map((c: any) => (
                            <tr key={c.key}>
                              <td>
                                {c.heading} <span className="faint small mono">{c.key}</span>
                              </td>
                              <td className="small">{c.type ?? 'text'}{c.formula ? ` · ${c.formula}` : ''}</td>
                              <td>{c.required ? t('common.yes') : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {r.inspection && (
                      <div style={{ marginTop: 10 }}>
                        {r.inspection.ok ? (
                          <Banner tone="good">{t('tpl.inspectionOk')}</Banner>
                        ) : (
                          <Banner
                            tone="warn"
                            action={
                              can('template:manage') && !r.feature_loss_acknowledged_by && (
                                <button className="btn sm" onClick={() => run(() => api(`/api/workbook-templates/${r.id}/acknowledge-feature-loss`, { body: {} })).then(books.reload)}>
                                  {t('tpl.ackLoss')}
                                </button>
                              )
                            }
                          >
                            {t('tpl.inspectionLoss', { features: r.inspection.unsupported.join(', ') })}
                          </Banner>
                        )}
                      </div>
                    )}
                  </Card>
                ))}
            </div>
          )}
        </Async>
      )}
    </div>
  );
}

export function Assistant() {
  const { t, tk } = useI18n();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const { run, busy } = useAction();
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api('/api/ai/ask', { body: { question: q } }));
    if (r) setRes(r);
  };
  const href = (r: any) => ({ personnel: `/personnel/${r.id}`, request: `/requests/${r.id}`, crew_change: `/crew-changes/${r.id}`, task: `/tasks?focus=${r.id}` })[r.type as string];
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <PageHeader title={t('ai.title')} sub={t('ai.subtitle')} />
      <form className="row" onSubmit={ask}>
        <label htmlFor="ai-q" className="sr-only">
          {t('ai.title')}
        </label>
        <input id="ai-q" className="input" style={{ flex: 1, height: 40 }} placeholder={t('ai.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} />
        <button className="btn primary" style={{ height: 40 }} disabled={busy || q.trim().length < 3}>
          <Icon name="spark" /> {t('ai.ask')}
        </button>
      </form>
      <p className="small faint">{t('ai.cannotAct')}</p>
      {res && (
        <>
          {res.mode === 'retrieval_only' && res.reason === 'ai_not_approved' && <Banner tone="info">{t('ai.disabled')}</Banner>}
          {res.answer && (
            <Card title={<span className="kind prediction">{t('ai.generated')}</span>}>
              <p style={{ whiteSpace: 'pre-wrap' }}>{res.answer}</p>
            </Card>
          )}
          {res.refused && <Banner tone="warn">{t('ai.refused')}</Banner>}
          {res.error && <Banner tone="warn">{t('ai.error')}</Banner>}
          <Card title={t('ai.records')}>
            {res.records.length ? (
              <ul className="feed">
                {res.records.map((r: any) => (
                  <li key={`${r.type}${r.id}`}>
                    <a href={href(r)}>{r.label}</a> <span className="faint small">· {r.type === 'request' ? tk(`type.${r.fields.type}`) : r.type === 'crew_change' ? t('nav.crewChanges') : r.type === 'task' ? t('nav.tasks') : t('nav.personnel')}</span>
                    <div className="faint small">
                      {r.fields.status && (r.type === 'request' ? tk(`status.request.${r.fields.status}`) : r.type === 'crew_change' ? tk(`status.cc.${r.fields.status}`) : r.type === 'task' ? tk(`status.task.${r.fields.status}`) : tk(`person.status.${r.fields.status}`))}
                      {r.fields.person && ` · ${r.fields.person}`}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{t('ai.noRecords')}</Empty>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
