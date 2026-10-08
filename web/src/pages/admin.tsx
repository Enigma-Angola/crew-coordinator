import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { useI18n, type Lang } from '../i18n';
import { useSession } from '../session';
import { Async, Badge, Banner, Card, Dialog, Empty, Icon, PageHeader, StatusBadge, Tabs, useAction } from '../components/ui';

type AdminTab = 'members' | 'invitations' | 'security' | 'audit' | 'settings';

export function Admin() {
  const { t } = useI18n();
  const { can } = useSession();
  const [q, setQ] = useSearchParams();
  const tab = (q.get('tab') as AdminTab) ?? 'members';
  const tabs = [
    { id: 'members' as AdminTab, label: t('admin.members') },
    ...(can('members:manage') ? [{ id: 'invitations' as AdminTab, label: t('admin.invitations') }] : []),
    ...(can('security:monitor') ? [{ id: 'security' as AdminTab, label: t('admin.security') }] : []),
    ...(can('audit:view') ? [{ id: 'audit' as AdminTab, label: t('admin.audit') }] : []),
    ...(can('settings:manage') ? [{ id: 'settings' as AdminTab, label: t('admin.settings') }] : []),
  ];
  return (
    <div className="stack">
      <PageHeader title={t('admin.title')} />
      <Tabs label={t('admin.title')} tabs={tabs} value={tab} onChange={(v) => setQ({ tab: v })} />
      {tab === 'members' && <Members />}
      {tab === 'invitations' && <Invitations />}
      {tab === 'security' && <Security />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'settings' && <OrgSettings />}
    </div>
  );
}

const ROLES = ['org_admin', 'manager', 'coordinator', 'hr_compliance', 'employee', 'supplier', 'auditor'];

function Members() {
  const { t, tk, relative } = useI18n();
  const { me, can } = useSession();
  const s = useApi<any[]>('/api/admin/members');
  const suppliers = useApi<any[]>(can('members:manage') ? '/api/suppliers' : null);
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<any>(null);
  const act = (id: string, action: string) => run(() => api(`/api/admin/members/${id}/${action}`, { body: {} }), t('common.saved')).then(s.reload);
  return (
    <div className="card">
      <Async state={s}>
        {(rows) => (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('admin.inviteRole')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('admin.lastLogin')}</th>
                  <th className="num">{t('settings.sessions')}</th>
                  <th>
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const self = m.user_id === me?.user.id;
                  return (
                    <tr key={m.id}>
                      <td>
                        <strong>{m.display_name}</strong>
                        <div className="faint small">{m.email}</div>
                      </td>
                      <td>
                        {tk(`role.${m.role}`)}
                        {m.supplier_name && <div className="faint small">{m.supplier_name}</div>}
                        {m.asset_scope?.length > 0 && <div className="faint small">{m.asset_scope.length} ×</div>}
                      </td>
                      <td>
                        <StatusBadge kind="member" status={m.status} />
                      </td>
                      <td className="small">{m.last_login_at ? relative(m.last_login_at) : '—'}</td>
                      <td className="num">{m.active_sessions}</td>
                      <td className="right">
                        {self ? (
                          <span className="faint small">{t('admin.cannotSelf')}</span>
                        ) : (
                          <span className="row" style={{ justifyContent: 'flex-end' }}>
                            {can('members:approve') && m.status === 'pending_approval' && (
                              <button className="btn sm primary" disabled={busy} onClick={() => act(m.id, 'approve')}>
                                {t('admin.approve')}
                              </button>
                            )}
                            {can('members:manage') && (
                              <button className="btn sm" onClick={() => setEditing(m)}>
                                {t('admin.changeRole')}
                              </button>
                            )}
                            {can('members:manage') && m.status === 'active' && (
                              <button className="btn sm danger" disabled={busy} onClick={() => act(m.id, 'suspend')}>
                                {t('admin.suspend')}
                              </button>
                            )}
                            {can('members:manage') && m.status === 'suspended' && (
                              <button className="btn sm" disabled={busy} onClick={() => act(m.id, 'reactivate')}>
                                {t('admin.reactivate')}
                              </button>
                            )}
                            {can('sessions:revoke') && m.active_sessions > 0 && (
                              <button className="btn sm ghost" disabled={busy} onClick={() => act(m.id, 'revoke-sessions')}>
                                {t('admin.revokeSessions')}
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Async>
      {editing && (
        <RoleDialog
          member={editing}
          suppliers={suppliers.data ?? []}
          onClose={() => setEditing(null)}
          onSave={(role, supplierId) => run(() => api(`/api/admin/members/${editing.id}`, { method: 'PATCH', body: { role, supplierId: role === 'supplier' ? supplierId : null, version: editing.version } }), t('common.saved')).then(() => (setEditing(null), s.reload()))}
        />
      )}
    </div>
  );
}

function RoleDialog({ member, suppliers, onClose, onSave }: { member: any; suppliers: any[]; onClose: () => void; onSave: (role: string, supplierId: string | null) => void }) {
  const { t, tk } = useI18n();
  const [role, setRole] = useState(member.role);
  const [sup, setSup] = useState(member.supplier_id ?? '');
  return (
    <Dialog
      title={`${t('admin.changeRole')} · ${member.display_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={role === 'supplier' && !sup} onClick={() => onSave(role, sup || null)}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="role">{t('admin.inviteRole')}</label>
        <select id="role" className="input" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {tk(`role.${r}`)}
            </option>
          ))}
        </select>
      </div>
      {role === 'supplier' && (
        <div className="field">
          <label htmlFor="sup">{t('admin.inviteSupplier')}</label>
          <select id="sup" className="input" value={sup} onChange={(e) => setSup(e.target.value)}>
            <option value="" />
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Dialog>
  );
}

function Invitations() {
  const { t, tk, dateTime } = useI18n();
  const s = useApi<any[]>('/api/admin/invitations');
  const suppliers = useApi<any[]>('/api/suppliers');
  const [f, setF] = useState({ email: '', role: 'employee', supplierId: '', language: 'pt-PT' as Lang });
  const [created, setCreated] = useState<any>(null);
  const { run, busy } = useAction();
  const invite = async () => {
    const r = await run(() => api('/api/admin/invitations', { body: { email: f.email, role: f.role, supplierId: f.role === 'supplier' ? f.supplierId : null, language: f.language } }));
    if (r) {
      setCreated(r);
      setF({ ...f, email: '' });
      s.reload();
    }
  };
  return (
    <div className="stack">
      <Card title={t('admin.invite')}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2, minWidth: 220 }}>
            <label htmlFor="inv-email">{t('admin.inviteEmail')}</label>
            <input id="inv-email" type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="inv-role">{t('admin.inviteRole')}</label>
            <select id="inv-role" className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {tk(`role.${r}`)}
                </option>
              ))}
            </select>
          </div>
          {f.role === 'supplier' && (
            <div className="field">
              <label htmlFor="inv-sup">{t('admin.inviteSupplier')}</label>
              <select id="inv-sup" className="input" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
                <option value="" />
                {suppliers.data?.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="inv-lang">{t('lang.label')}</label>
            <select id="inv-lang" className="input" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value as Lang })}>
              <option value="pt-PT">{t('lang.pt-PT')}</option>
              <option value="en">{t('lang.en')}</option>
            </select>
          </div>
          <button className="btn primary" disabled={busy || !f.email || (f.role === 'supplier' && !f.supplierId)} onClick={invite}>
            {t('common.invite')}
          </button>
        </div>
        {created && (
          <div className="stack" style={{ marginTop: 12, gap: 8 }}>
            <Banner tone="good">{t('admin.inviteCreated')}</Banner>
            <div className="row">
              <code style={{ wordBreak: 'break-all' }}>{created.inviteUrl}</code>
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(created.inviteUrl)}>
                {t('common.copy')}
              </button>
            </div>
            <div className="email">
              <dl className="h">
                <dt>{t('pkg.subject')}</dt>
                <dd>{created.email.subject}</dd>
              </dl>
              <pre>{created.email.body}</pre>
            </div>
          </div>
        )}
      </Card>
      <div className="card">
        <Async state={s} empty={(d) => !d.length}>
          {(rows) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('admin.inviteEmail')}</th>
                    <th>{t('admin.inviteRole')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.date')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td>
                      <td>{tk(`role.${i.role}`)}</td>
                      <td>{i.accepted_at ? <Badge tone="good">{t('common.yes')}</Badge> : i.revoked_at ? <Badge>{t('status.pkg.cancelled')}</Badge> : <Badge tone="warn">{t('workspace.pending')}</Badge>}</td>
                      <td className="small">{dateTime(i.created_at)}</td>
                      <td className="right">
                        {!i.accepted_at && !i.revoked_at && (
                          <button className="btn sm ghost" onClick={() => run(() => api(`/api/admin/invitations/${i.id}`, { method: 'DELETE' })).then(s.reload)}>
                            {t('common.delete')}
                          </button>
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
    </div>
  );
}

function Security() {
  const { t, tk, dateTime } = useI18n();
  const s = useApi<any[]>('/api/admin/security/alerts');
  const { run } = useAction();
  return (
    <Card title={t('admin.alerts')}>
      <Async state={s} empty={(d) => !d.length}>
        {(rows) => (
          <div className="stack" style={{ gap: 8 }}>
            {rows.map((a) => (
              <div key={a.id} className={`insight ${a.severity === 'critical' ? 'critical' : 'warning'}`}>
                <div className="row between">
                  <strong>{tk(`admin.alert.${a.code}`, { subject: a.detail?.subject })}</strong>
                  <Badge tone={a.status === 'open' ? (a.severity === 'critical' ? 'critical' : 'warn') : 'neutral'}>{tk(`alert.status.${a.status}`)}</Badge>
                </div>
                <div className="faint small">
                  {dateTime(a.created_at)}
                  {a.detail?.count ? ` · ${a.detail.count}` : ''}
                </div>
                {a.status !== 'closed' && (
                  <div className="row">
                    {a.status === 'open' && (
                      <button className="btn sm" onClick={() => run(() => api(`/api/admin/security/alerts/${a.id}/acknowledge`, { body: {} })).then(s.reload)}>
                        {t('admin.alertAck')}
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={() => run(() => api(`/api/admin/security/alerts/${a.id}/close`, { body: {} })).then(s.reload)}>
                      {t('admin.alertClose')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Async>
    </Card>
  );
}

function AuditLog() {
  const { t, tk, dateTime } = useI18n();
  const s = useApi<any[]>('/api/admin/audit?limit=200');
  const [verify, setVerify] = useState<any>(null);
  const { run } = useAction();
  return (
    <div className="stack">
      <div className="row">
        <button className="btn" onClick={() => run(() => api('/api/admin/audit/verify')).then(setVerify)}>
          <Icon name="shield" /> {t('admin.auditVerify')}
        </button>
        {verify && (verify.valid ? <Banner tone="good">{t('admin.auditValid', { count: verify.checked })}</Banner> : <Banner tone="critical">{t('admin.auditBroken', { seq: verify.brokenAtSeq })}</Banner>)}
      </div>
      <div className="card">
        <Async state={s} empty={(d) => !d.length}>
          {(rows) => (
            <div className="table-wrap" style={{ maxHeight: 620 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('audit.col.when')}</th>
                    <th>{t('audit.col.who')}</th>
                    <th>{t('audit.col.what')}</th>
                    <th>{t('audit.col.record')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.seq}>
                      <td className="num faint">{e.seq}</td>
                      <td className="nowrap small">{dateTime(e.at)}</td>
                      <td>{e.actor ?? '—'}</td>
                      <td>
                        {tk(`audit.${e.action}`)}
                        <div className="faint small mono">{e.action}</div>
                      </td>
                      <td className="small mono">{e.entity_type ? `${e.entity_type}:${String(e.entity_id ?? '').slice(0, 8)}` : '—'}</td>
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

function OrgSettings() {
  const { t } = useI18n();
  const s = useApi<any>('/api/admin/settings');
  const { run, busy } = useAction();
  const save = (patch: Record<string, unknown>) => run(() => api('/api/admin/settings', { method: 'PATCH', body: patch }), t('common.saved')).then(s.reload);
  return (
    <Async state={s}>
      {(o) => (
        <div className="grid halves">
          <Card title={t('settings.security')}>
            <div className="stack" style={{ gap: 12 }}>
              <label className="check">
                <input type="checkbox" checked={o.mfa_required} disabled={busy} onChange={(e) => save({ mfa_required: e.target.checked })} />
                {t('admin.mfaRequired')}
              </label>
              <label className="check">
                <input type="checkbox" checked={o.phishing_resistant_admins} disabled={busy} onChange={(e) => save({ phishing_resistant_admins: e.target.checked })} />
                {t('admin.phishingResistant')}
              </label>
              <div className="field">
                <label htmlFor="idp">{t('admin.requiredIdp')}</label>
                <select id="idp" className="input" value={o.required_idp ?? ''} onChange={(e) => save({ required_idp: e.target.value || null })}>
                  <option value="">{t('admin.ssoNone')}</option>
                  {o.identityProviders.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="idle">{t('admin.sessionIdle')}</label>
                <input id="idle" type="number" min={5} max={480} className="input" defaultValue={o.session_idle_minutes} onBlur={(e) => save({ session_idle_minutes: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="exp">{t('admin.exportThreshold')}</label>
                <input id="exp" type="number" min={1} className="input" defaultValue={o.export_alert_threshold} onBlur={(e) => save({ export_alert_threshold: Number(e.target.value) })} />
              </div>
            </div>
          </Card>
          <Card title={t('admin.aiProvider')}>
            <div className="stack" style={{ gap: 10 }}>
              <label className="check">
                <input type="radio" name="ai" checked={o.ai_provider === 'none'} onChange={() => save({ ai_provider: 'none' })} />
                {t('admin.aiNone')}
              </label>
              <label className="check">
                <input type="radio" name="ai" disabled={!o.aiProviderAvailable.anthropic} checked={o.ai_provider === 'anthropic'} onChange={() => save({ ai_provider: 'anthropic' })} />
                {t('admin.aiAnthropic')} {!o.aiProviderAvailable.anthropic && <span className="faint">({t('comm.connectorNotConfigured')})</span>}
              </label>
              <p className="small muted">{t('admin.aiHelp')}</p>
              <p className="small faint">{t('ai.cannotAct')}</p>
            </div>
          </Card>
        </div>
      )}
    </Async>
  );
}

/* Personal settings ---------------------------------------------------------------------------- */
export function Settings() {
  const { t, tk, lang, setLang, setTimeZone, timeZone, relative, dateTime } = useI18n();
  const { me, can, refresh } = useSession();
  const { section } = useParams();
  const sessions = useApi<any[]>('/api/me/sessions');
  const mailboxes = useApi<any[]>(can('email:view') ? '/api/mailboxes' : null);
  const connectors = useApi<any>(can('email:view') ? '/api/connectors' : null);
  const [q] = useSearchParams();
  const { run, busy } = useAction();
  const [shared, setShared] = useState('');
  const zones = ['Africa/Luanda', 'Europe/Lisbon', 'Europe/London', 'UTC', 'Africa/Johannesburg', 'America/Houston', 'Asia/Dubai'];
  const savePrefs = (p: Record<string, string>) => run(() => api('/api/me/preferences', { method: 'PATCH', body: p }), t('common.saved')).then(refresh);
  const connect = async (body: Record<string, unknown>) => {
    const r = await run(() => api('/api/mailboxes/connect', { body }));
    if (r?.authorizeUrl) window.location.assign(r.authorizeUrl);
  };
  return (
    <div className="stack">
      <PageHeader title={t('settings.title')} />
      {q.get('connected') && <Banner tone="good">{t('status.mailbox.connected')}</Banner>}
      {q.get('error') && <Banner tone="critical">{tk(`settings.error.${q.get('error')}`)}</Banner>}
      <div className="grid halves">
        <Card title={t('settings.preferences')}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="field">
              <label htmlFor="pref-lang">{t('lang.label')}</label>
              <select id="pref-lang" className="input" value={lang} onChange={(e) => (setLang(e.target.value as Lang), savePrefs({ language: e.target.value }))}>
                <option value="pt-PT">{t('lang.pt-PT')}</option>
                <option value="en">{t('lang.en')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pref-tz">{t('timezone.label')}</label>
              <select id="pref-tz" className="input" value={timeZone} onChange={(e) => (setTimeZone(e.target.value), savePrefs({ timezone: e.target.value }))}>
                {[...new Set([timeZone, ...zones])].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>
        <Card title={t('settings.security')}>
          <div className="stack" style={{ gap: 6 }}>
            <Banner tone={me?.session.mfa ? 'good' : 'warn'}>{me?.session.mfa ? t('settings.mfaOn') : t('settings.mfaOff')}</Banner>
            {me?.session.phishingResistant && <Banner tone="good">{t('settings.phishingResistant')}</Banner>}
          </div>
        </Card>
      </div>
      <Card title={t('settings.sessions')}>
        <Async state={sessions} empty={(d) => !d.length}>
          {(rows) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('sessions.device')}</th>
                    <th>{t('sessions.started')}</th>
                    <th>{t('sessions.lastActive')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <span className="small">{x.user_agent?.slice(0, 70) ?? '—'}</span>
                        <div className="faint small">
                          {x.ip} · {x.amr?.join(', ')}
                        </div>
                      </td>
                      <td className="small">{dateTime(x.created_at)}</td>
                      <td className="small">{relative(x.last_seen_at)}</td>
                      <td className="right">
                        {x.current ? (
                          <Badge tone="info">{t('settings.thisSession')}</Badge>
                        ) : (
                          <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/api/me/sessions/${x.id}`, { method: 'DELETE' })).then(sessions.reload)}>
                            {t('settings.revoke')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>
      {can('email:view') && (
        <Card title={t('settings.mailboxes')} question={t('settings.mailboxHelp')} id={section === 'mailboxes' ? 'mailboxes' : undefined}>
          <div className="stack">
            {mailboxes.data?.length ? (
              mailboxes.data.map((m) => (
                <div key={m.id} className="file">
                  <Icon name="mail" size={20} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {m.address} <span className="faint small">({m.kind === 'shared' ? t('settings.sharedMailbox') : t('settings.individualMailbox')} · Microsoft 365)</span>
                    </div>
                    <div className="faint small">
                      {t('settings.mailboxScopes', { scopes: m.scopes.join(' ') })} · {t('settings.mailboxFolders')}: {m.sync_folders.join(', ')}
                      {m.last_sync_at && ` · ${t('settings.lastSync', { when: relative(m.last_sync_at) })}`}
                    </div>
                  </div>
                  <StatusBadge kind="mailbox" status={m.status} />
                  {can('email:associate') && m.status === 'connected' && (
                    <button className="btn sm" disabled={busy} onClick={() => run(() => api(`/api/mailboxes/${m.id}/sync`, { body: {} })).then(mailboxes.reload)}>
                      {t('settings.syncNow')}
                    </button>
                  )}
                  {can('mailbox:manage') && m.status !== 'revoked' && (
                    <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api(`/api/mailboxes/${m.id}/disconnect`, { body: {} })).then(mailboxes.reload)}>
                      {t('settings.disconnect')}
                    </button>
                  )}
                </div>
              ))
            ) : (
              <Empty icon="mail">{t('comm.demoMode')}</Empty>
            )}
            {can('mailbox:manage') && connectors.data && (
              <div className="row">
                {connectors.data.connectors.map((c: any) =>
                  c.provider === 'microsoft' ? (
                    <span key="ms" className="row">
                      <button className="btn primary" disabled={!c.available || busy} onClick={() => connect({ provider: 'microsoft', kind: 'individual' })}>
                        {t('settings.connectMicrosoft')}
                      </button>
                      <input className="input" type="email" placeholder={t('settings.sharedAddress')} aria-label={t('settings.sharedAddress')} value={shared} onChange={(e) => setShared(e.target.value)} />
                      <button className="btn" disabled={!c.available || !shared || busy} onClick={() => connect({ provider: 'microsoft', kind: 'shared', sharedAddress: shared })}>
                        {t('settings.connectShared')}
                      </button>
                      {!c.available && <span className="faint small">{t('comm.connectorNotConfigured')}</span>}
                    </span>
                  ) : (
                    <span key="g" className="row">
                      <button className="btn" disabled title={t('comm.connectorUnavailable')}>
                        {t('settings.connectGoogle')}
                      </button>
                      <Badge>{t('comm.connectorUnavailable')}</Badge>
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
