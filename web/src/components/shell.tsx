import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../api';
import { useI18n, type Lang, type MessageKey } from '../i18n';
import { useSession } from '../session';
import { useApi } from '../hooks';
import { Icon, Logo } from './ui';

interface NavItem {
  to: string;
  label: MessageKey;
  icon: string;
  perm?: string;
  anyRole?: string[];
}

const NAV: { group: MessageKey; items: NavItem[] }[] = [
  {
    group: 'nav.groupOperations',
    items: [
      { to: '/', label: 'nav.dashboard', icon: 'dashboard' },
      { to: '/crew-changes', label: 'nav.crewChanges', icon: 'ship', perm: 'crew_change:view' },
      { to: '/requests', label: 'nav.requests', icon: 'truck', perm: 'request:view' },
      { to: '/communications', label: 'nav.communications', icon: 'mail', perm: 'email:view' },
      { to: '/calendar', label: 'nav.calendar', icon: 'calendar', perm: 'request:view' },
      { to: '/tasks', label: 'nav.tasks', icon: 'tasks', perm: 'task:view' },
    ],
  },
  {
    group: 'nav.groupPeople',
    items: [
      { to: '/personnel', label: 'nav.personnel', icon: 'people', perm: 'personnel:view' },
      { to: '/readiness', label: 'nav.readiness', icon: 'grid', perm: 'personnel:view', anyRole: ['org_admin', 'manager', 'coordinator', 'hr_compliance'] },
      { to: '/rotation', label: 'nav.rotation', icon: 'timeline', perm: 'crew_change:view', anyRole: ['org_admin', 'manager', 'coordinator', 'hr_compliance'] },
      { to: '/assistant', label: 'nav.assistant', icon: 'spark', perm: 'ai:use' },
    ],
  },
  {
    group: 'nav.groupConfig',
    items: [
      { to: '/suppliers', label: 'nav.suppliers', icon: 'truck', perm: 'email:view' },
      { to: '/templates', label: 'nav.templates', icon: 'file', perm: 'email:view' },
      { to: '/admin', label: 'nav.admin', icon: 'shield', perm: 'members:view' },
      { to: '/settings', label: 'nav.settings', icon: 'settings' },
    ],
  },
];

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function LanguageSwitcher({ persist = true }: { persist?: boolean }) {
  const { lang, setLang, t } = useI18n();
  const change = async (l: Lang) => {
    setLang(l);
    if (persist) await api('/api/me/preferences', { method: 'PATCH', body: { language: l } }).catch(() => undefined);
  };
  return (
    <label className="row lang-switch" style={{ gap: 6 }}>
      <span className="hide-sm" style={{ display: 'inline-flex' }}><Icon name="globe" /></span>
      <span className="sr-only">{t('lang.label')}</span>
      <select className="input" value={lang} onChange={(e) => change(e.target.value as Lang)} aria-label={t('lang.label')} style={{ height: 30 }}>
        <option value="pt-PT" lang="pt-PT">
          Português
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}

export function ThemeSwitcher() {
  const { t } = useI18n();
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('cc.theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('cc.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return (
    <select className="input hide-sm" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label={t('theme.label')} style={{ height: 30 }}>
      <option value="system">{t('theme.system')}</option>
      <option value="light">{t('theme.light')}</option>
      <option value="dark">{t('theme.dark')}</option>
    </select>
  );
}

function WorkspaceSwitcher() {
  const { me, switchWorkspace } = useSession();
  const { t, tk } = useI18n();
  const p = usePopover();
  if (!me) return null;
  return (
    <div style={{ position: 'relative' }} ref={p.ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)} title={t('workspace.switch')}>
        <Icon name="ship" />
        <span className="nowrap ws-name">
          {me.activeOrg?.name ?? t('workspace.choose')}
        </span>
        <Icon name="chevron" size={12} />
      </button>
      {p.open && (
        <div className="popover" role="menu" style={{ left: 0, right: 'auto' }}>
          <div className="faint small" style={{ padding: '6px 10px' }}>
            {t('workspace.label')}
          </div>
          {me.memberships.map((m) => (
            <button key={m.orgId} role="menuitem" className="item" aria-current={m.orgId === me.activeOrg?.id} onClick={() => switchWorkspace(m.orgId)}>
              <span style={{ flex: 1 }}>
                {m.orgName}
                <div className="faint small">
                  {tk(`role.${m.role}`)}
                  {m.status !== 'active' && ` · ${tk(`status.member.${m.status}`)}`}
                </div>
              </span>
              {m.orgId === me.activeOrg?.id && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { t, tk, relative } = useI18n();
  const { me } = useSession();
  const p = usePopover();
  const s = useApi<any[]>(me?.activeOrg && !me.orgBlock ? '/api/notifications' : null, [me?.activeOrg?.id]);
  const unread = s.data?.filter((n) => !n.read_at).length ?? 0;
  const href = (n: any) => (n.entity_type === 'task' ? `/tasks?focus=${n.entity_id}` : n.entity_type === 'package' ? `/communications/packages/${n.entity_id}` : n.entity_type === 'crew_change' ? `/crew-changes/${n.entity_id}` : n.entity_type === 'request' ? `/requests/${n.entity_id}` : '#');
  return (
    <div style={{ position: 'relative' }} ref={p.ref}>
      <button className="btn ghost icon" aria-label={`${t('notif.title')}${unread ? ` (${unread})` : ''}`} aria-expanded={p.open} onClick={() => (p.setOpen(!p.open), s.reload())}>
        <Icon name="bell" />
        {unread > 0 && <span style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 4, background: 'var(--mark-critical)' }} aria-hidden />}
      </button>
      {p.open && (
        <div className="popover" style={{ width: 340 }}>
          <div style={{ padding: '6px 10px', fontWeight: 600 }}>{t('notif.title')}</div>
          {!s.data?.length && <div className="faint small" style={{ padding: 10 }}>{t('notif.empty')}</div>}
          {s.data?.slice(0, 12).map((n) => (
            <a key={n.id} className="item" href={href(n)} onClick={() => api(`/api/notifications/${n.id}/read`, { body: {} }).catch(() => undefined)} style={{ fontWeight: n.read_at ? 400 : 600 }}>
              <span style={{ flex: 1 }}>
                {tk(`notif.${n.code}`, n.params)}
                <div className="faint small" style={{ fontWeight: 400 }}>
                  {relative(n.created_at)}
                </div>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const { t, tk } = useI18n();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const visible = (i: NavItem) => (!i.perm || can(i.perm)) && (!i.anyRole || (me?.role && i.anyRole.includes(me.role)));
  const logout = async () => {
    await api('/auth/logout', { body: {} }).catch(() => undefined);
    window.location.assign('/signin');
  };
  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t('app.skip')}
      </a>
      <nav className={`sidebar ${menu ? 'open' : ''}`} aria-label={t('nav.menu')}>
        <div className="brand">
          <Logo /> {t('app.name')}
        </div>
        {NAV.map((g) => {
          const items = g.items.filter(visible);
          if (!items.length) return null;
          return (
            <div key={g.group}>
              <div className="group">{t(g.group)}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} className="nav">
                  <Icon name={i.icon} /> {t(i.label)}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="footer">
          <div style={{ color: '#fff', fontWeight: 600 }}>{me?.user.displayName}</div>
          <div>{me?.role ? tk(`role.${me.role}`) : ''}</div>
          <button className="btn sm" style={{ marginTop: 10, background: 'transparent', color: '#dfe6f0', borderColor: 'rgba(255,255,255,0.25)' }} onClick={logout}>
            {t('nav.signOut')}
          </button>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-toggle" aria-label={t('nav.menu')} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="menu" />
          </button>
          <WorkspaceSwitcher />
          <div className="spacer" />
          <LanguageSwitcher />
          <ThemeSwitcher />
          {me?.activeOrg && <Notifications />}
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
      {menu && <div className="overlay" style={{ zIndex: 40, background: 'rgba(0,0,0,0.3)' }} onClick={() => setMenu(false)} />}
    </div>
  );
}
