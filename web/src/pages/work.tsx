import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useApi } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Activity, Comments } from '../components/ops';
import { Async, Badge, Card, ConflictDialog, Dialog, ErrorText, Icon, PageHeader, StatusBadge, type ConflictInfo, useAction, useToast } from '../components/ui';

/* Calendar ------------------------------------------------------------------------------------ */
export function Calendar() {
  const { t, tk, locale, time, tzName, timeZone } = useI18n();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  });
  const start = new Date(month);
  start.setUTCDate(1 - ((start.getUTCDay() + 6) % 7)); // weeks start on Monday
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86400_000));
  const from = days[0].toISOString().slice(0, 10);
  const to = days[41].toISOString().slice(0, 10);
  const s = useApi<any>(`/api/calendar?from=${from}&to=${to}`, [from]);
  const today = new Date().toISOString().slice(0, 10);
  const dayKey = (e: any) => (e.date ? e.date : new Intl.DateTimeFormat('en-CA', { timeZone: e.timezone ?? timeZone }).format(new Date(e.startsAt)));
  const byDay = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const e of s.data?.events ?? []) m.set(dayKey(e), [...(m.get(dayKey(e)) ?? []), e]);
    return m;
  }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(month);
  const dows = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const shift = (n: number) => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + n, 1)));
  return (
    <div className="stack">
      <PageHeader
        title={t('cal.title')}
        sub={`${t('cal.subtitle')} ${t('timezone.shownIn', { tz: tzName() })}`}
        actions={
          <>
            <button className="btn icon" onClick={() => shift(-1)} aria-label={t('cal.prev')}>
              <Icon name="chevronL" />
            </button>
            <strong style={{ minWidth: 150, textAlign: 'center', textTransform: 'capitalize' }} aria-live="polite">
              {title}
            </strong>
            <button className="btn icon" onClick={() => shift(1)} aria-label={t('cal.next')}>
              <Icon name="chevron" />
            </button>
            <button className="btn" onClick={() => setMonth(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)))}>
              {t('cal.today')}
            </button>
          </>
        }
      />
      <Async state={s}>
        {() => (
          <div className="calendar" role="grid" aria-label={title}>
            <div role="row" style={{ display: 'contents' }}>
              {dows.map((d) => (
                <div key={d} className="dow" role="columnheader">
                  {d}
                </div>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, w) => (
            <div key={w} role="row" style={{ display: 'contents' }}>
            {days.slice(w * 7, w * 7 + 7).map((d) => {
              const k = d.toISOString().slice(0, 10);
              const evs = byDay.get(k) ?? [];
              return (
                <div key={k} role="gridcell" className={`day ${d.getUTCMonth() !== month.getUTCMonth() ? 'other' : ''} ${k === today ? 'today' : ''}`} aria-label={k}>
                  <span className="n">{d.getUTCDate()}</span>
                  {evs.slice(0, 4).map((e) => (
                    <Link
                      key={`${e.kind}${e.id}`}
                      className={`ev ${e.kind}`}
                      to={e.kind === 'crew_change' ? `/crew-changes/${e.id}` : `/requests/${e.id}`}
                      title={`${tk(`cal.kind.${e.kind}`)} · ${e.reference} · ${e.title}`}
                    >
                      {e.kind === 'crew_change' ? `${e.reference} · ${e.title}` : `${time(e.startsAt, e.timezone)} ${tk(`type.${e.type}`)} · ${e.title}`}
                    </Link>
                  ))}
                  {evs.length > 4 && <span className="faint small">{t('cal.more', { count: evs.length - 4 })}</span>}
                </div>
              );
            })}
            </div>
            ))}
          </div>
        )}
      </Async>
      <div className="legend" aria-label={t('cal.legend')}>
        {(['movement', 'appointment', 'crew_change'] as const).map((k) => (
          <span key={k}>
            <span className="key" style={{ background: k === 'movement' ? 'var(--series-1)' : k === 'appointment' ? 'var(--series-4)' : 'var(--brand)' }} />
            {tk(`cal.kind.${k}`)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* Task board ---------------------------------------------------------------------------------- */
type Group = 'status' | 'owner' | 'deadline';
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];

export function Tasks() {
  const { t, tk, dateTime } = useI18n();
  const { me, can } = useSession();
  const [q, setQ] = useSearchParams();
  const [group, setGroup] = useState<Group>('status');
  const [mine, setMine] = useState(false);
  const s = useApi<any[]>(`/api/tasks${mine ? '?assigneeId=me' : ''}`, [mine]);
  const [creating, setCreating] = useState(false);
  const focus = q.get('focus');
  const toast = useToast();
  const [conflict, setConflict] = useState<{ info: ConflictInfo; id: string } | null>(null);

  const move = async (task: any, status: string) => {
    try {
      await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { version: task.version, changes: { status }, base: { status: task.status } } });
      s.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'edit_conflict') setConflict({ info: e.details, id: task.id });
      else if (e instanceof ApiError) toast(<ErrorText error={e} />, 'error');
    }
  };

  const columns = useMemo(() => {
    const list = s.data ?? [];
    if (group === 'status') return STATUSES.map((st) => ({ key: st, title: tk(`status.task.${st}`), items: list.filter((x) => x.status === st) }));
    if (group === 'owner') {
      const owners = [...new Map(list.map((x) => [x.assignee_id ?? '', x.assignee_name ?? t('task.unassigned')])).entries()];
      return owners.map(([k, name]) => ({ key: k || 'none', title: name, items: list.filter((x) => (x.assignee_id ?? '') === k && x.status !== 'done') }));
    }
    const now = Date.now();
    const endToday = new Date();
    endToday.setHours(23, 59, 59, 999);
    const bucket = (x: any) => {
      if (!x.due_at) return 'none';
      const d = new Date(x.due_at).getTime();
      if (d < now) return 'overdue';
      if (d <= endToday.getTime()) return 'today';
      if (d <= now + 7 * 86400_000) return 'week';
      return 'later';
    };
    return ['overdue', 'today', 'week', 'later', 'none'].map((b) => ({ key: b, title: tk(`task.deadline.${b}`), items: list.filter((x) => x.status !== 'done' && bucket(x) === b) }));
  }, [s.data, group, t, tk]);

  const focused = s.data?.find((x) => x.id === focus);
  return (
    <div className="stack">
      <PageHeader
        title={t('task.title')}
        sub={t('task.subtitle')}
        actions={
          <>
            <div className="seg" role="group" aria-label={t('task.groupBy')}>
              {(['status', 'owner', 'deadline'] as Group[]).map((g) => (
                <button key={g} aria-pressed={group === g} onClick={() => setGroup(g)}>
                  {t(g === 'status' ? 'task.groupStatus' : g === 'owner' ? 'task.groupOwner' : 'task.groupDeadline')}
                </button>
              ))}
            </div>
            <label className="check small">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {t('task.mine')}
            </label>
            {can('task:edit') && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <Icon name="plus" /> {t('task.new')}
              </button>
            )}
          </>
        }
      />
      <Async state={s}>
        {() => (
          <div className="board">
            {columns.map((c) => (
              <section key={c.key} className="column" aria-label={c.title}>
                <div className="col-head">
                  <span>{c.title}</span>
                  <span className="faint">{c.items.length}</span>
                </div>
                {c.items.map((task: any) => {
                  const overdue = task.due_at && new Date(task.due_at) < new Date() && task.status !== 'done';
                  const editable = can('task:edit') || task.assignee_id === me?.user.id;
                  return (
                    <article key={task.id} className="taskcard" style={task.id === focus ? { outline: '2px solid var(--focus)' } : undefined}>
                      <button className="t" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', font: 'inherit', fontWeight: 600, color: 'var(--text)', cursor: 'pointer' }} onClick={() => setQ({ focus: task.id })}>
                        {task.title}
                      </button>
                      <div className="m">
                        <Badge tone={task.priority === 'urgent' ? 'critical' : task.priority === 'high' ? 'warn' : 'neutral'}>{tk(`priority.${task.priority}`)}</Badge>
                        <span>{tk(`task.kind.${task.kind}`)}</span>
                      </div>
                      <div className="m">
                        <span>
                          <Icon name="people" size={12} /> {task.assignee_name ?? t('task.unassigned')}
                        </span>
                        {task.due_at && (
                          <span style={{ color: overdue ? 'var(--critical)' : undefined }}>
                            <Icon name="clock" size={12} /> {dateTime(task.due_at)} {overdue && `· ${t('task.overdue')}`}
                          </span>
                        )}
                      </div>
                      {(task.crew_change_reference || task.personnel_name) && (
                        <div className="m">
                          {task.crew_change_id && <Link to={`/crew-changes/${task.crew_change_id}`}>{task.crew_change_reference}</Link>}
                          {task.personnel_name && <span>{task.personnel_name}</span>}
                          {task.comment_count > 0 && <span>{t('task.commentCount', { count: task.comment_count })}</span>}
                        </div>
                      )}
                      {editable && (
                        <label className="small row" style={{ gap: 6 }}>
                          {t('task.moveTo')}
                          <select className="input" style={{ height: 26 }} value={task.status} onChange={(e) => move(task, e.target.value)} aria-label={`${t('task.moveTo')}: ${task.title}`}>
                            {[...STATUSES, ...(can('task:edit') ? ['cancelled'] : [])].map((st) => (
                              <option key={st} value={st}>
                                {tk(`status.task.${st}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </Async>
      {focused && (
        <Dialog title={focused.title} onClose={() => setQ({})} wide>
          <div className="row">
            <StatusBadge kind="task" status={focused.status} />
            <span className="muted small">
              {t('task.assignee')}: {focused.assignee_name ?? t('task.unassigned')} · {t('task.due')}: {dateTime(focused.due_at)}
            </span>
          </div>
          {focused.description && <p>{focused.description}</p>}
          <div className="grid halves">
            <Card title={t('task.comments')}>
              <Comments entityType="task" entityId={focused.id} />
            </Card>
            <Card title={t('task.activity')}>
              <Activity entityType="task" entityId={focused.id} />
            </Card>
          </div>
        </Dialog>
      )}
      {creating && <NewTask onClose={() => (setCreating(false), s.reload())} />}
      {conflict && (
        <ConflictDialog
          info={conflict.info}
          labelFor={(f) => (f === 'status' ? t('common.status') : f)}
          onCancel={() => (setConflict(null), s.reload())}
          onResolve={async (keep, version) => {
            if (Object.keys(keep).length) await api(`/api/tasks/${conflict.id}`, { method: 'PATCH', body: { version, changes: keep } }).catch(() => undefined);
            setConflict(null);
            s.reload();
          }}
        />
      )}
    </div>
  );
}

function NewTask({ onClose }: { onClose: () => void }) {
  const { t, tk } = useI18n();
  const dir = useApi<any[]>('/api/directory');
  const [f, setF] = useState({ title: '', kind: 'general', priority: 'normal', assigneeId: '', dueAt: '', description: '' });
  const { run, busy } = useAction();
  const submit = () =>
    run(() => api('/api/tasks', { body: { ...f, assigneeId: f.assigneeId || null, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null, description: f.description || null } }), t('common.saved')).then((r) => r && onClose());
  return (
    <Dialog
      title={t('task.new')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !f.title.trim()} onClick={submit}>
            {t('common.create')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="nt-title">{t('common.name')}</label>
        <input id="nt-title" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </div>
      <div className="grid halves">
        <div className="field">
          <label htmlFor="nt-kind">{t('common.type')}</label>
          <select id="nt-kind" className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {['general', 'onboarding', 'verification', 'document_request', 'mobilisation'].map((k) => (
              <option key={k} value={k}>
                {tk(`task.kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nt-pri">{t('task.priority')}</label>
          <select id="nt-pri" className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {['low', 'normal', 'high', 'urgent'].map((k) => (
              <option key={k} value={k}>
                {tk(`priority.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nt-ass">{t('task.assignee')}</label>
          <select id="nt-ass" className="input" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">{t('task.unassigned')}</option>
            {dir.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nt-due">{t('task.due')}</label>
          <input id="nt-due" type="datetime-local" className="input" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="nt-desc">{t('common.notes')}</label>
        <textarea id="nt-desc" className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
    </Dialog>
  );
}
