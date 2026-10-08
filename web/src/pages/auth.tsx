import { useParams, useSearchParams } from 'react-router-dom';
import { loginUrl } from '../api';
import { useApi } from '../hooks';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { LanguageSwitcher, ThemeSwitcher } from '../components/shell';
import { Banner, Icon, Logo } from '../components/ui';

function Frame({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="signin">
      <main className="card panel" id="main">
        <div className="row between">
          <div className="row" style={{ gap: 10, fontWeight: 650, fontSize: 16 }}>
            <Logo /> {t('app.name')}
          </div>
          <div className="row">
            <LanguageSwitcher persist={false} />
            <ThemeSwitcher />
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}

export function SignIn() {
  const { t, tk } = useI18n();
  const [q] = useSearchParams();
  const providers = useApi<{ id: string; name: string }[]>('/auth/providers');
  const error = q.get('error');
  const returnTo = q.get('returnTo') ?? '/';
  return (
    <Frame>
      <div>
        <h1>{t('auth.signIn')}</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          {t('app.tagline')}
        </p>
      </div>
      {error && <Banner tone="critical">{tk(`auth.error.${error}`)}</Banner>}
      <div className="stack" style={{ gap: 8 }}>
        {(providers.data ?? []).map((p) => (
          <a key={p.id} className="btn primary" style={{ height: 40 }} href={loginUrl({ idp: p.id, returnTo })}>
            <Icon name="lock" /> {t('auth.signInWith', { provider: p.name })}
          </a>
        ))}
      </div>
      <p className="small faint">{t('auth.signInHelp')}</p>
    </Frame>
  );
}

export function Invite() {
  const { t } = useI18n();
  const { token } = useParams();
  return (
    <Frame>
      <div>
        <h1>{t('auth.inviteTitle')}</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          {t('auth.inviteHelp')}
        </p>
      </div>
      <a className="btn primary" style={{ height: 40 }} href={loginUrl({ invitation: token, returnTo: '/' })}>
        <Icon name="lock" /> {t('auth.inviteAccept')}
      </a>
    </Frame>
  );
}

/** Shown when the session cannot use a workspace: none chosen, pending, suspended, or MFA/SSO needed. */
export function WorkspaceGate() {
  const { me, switchWorkspace } = useSession();
  const { t, tk } = useI18n();
  if (!me) return null;
  const block = me.orgBlock;
  const messages: Record<string, [string, string, { mfa?: boolean } | null]> = {
    mfa_required: ['auth.mfaRequired', 'auth.mfaRequiredHelp', { mfa: true }],
    phishing_resistant_required: ['auth.phishingResistantRequired', 'auth.phishingResistantRequiredHelp', { mfa: true }],
    sso_required: ['auth.ssoRequired', 'auth.ssoRequiredHelp', {}],
    membership_pending: ['workspace.pending', 'auth.membershipPending', null],
    membership_suspended: ['workspace.suspended', 'auth.membershipSuspended', null],
  };
  const m = block ? messages[block] : null;
  return (
    <Frame>
      {m ? (
        <>
          <h1>{tk(m[0])}</h1>
          <p className="muted">{tk(m[1])}</p>
          {m[2] && (
            <a className="btn primary" style={{ height: 40 }} href={loginUrl({ mfa: !!m[2].mfa, stepup: true, returnTo: '/' })}>
              <Icon name="lock" /> {t('auth.reauth')}
            </a>
          )}
        </>
      ) : (
        <>
          <h1>{t('workspace.choose')}</h1>
          <p className="muted">{me.memberships.length ? t('workspace.chooseHelp') : t('workspace.none')}</p>
        </>
      )}
      {me.memberships.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          {me.memberships.map((ms) => (
            <button key={ms.orgId} className="btn" style={{ height: 'auto', padding: 12, justifyContent: 'space-between' }} onClick={() => switchWorkspace(ms.orgId)} disabled={ms.status !== 'active'}>
              <span style={{ textAlign: 'left' }}>
                <strong>{ms.orgName}</strong>
                <div className="faint small">{tk(`role.${ms.role}`)}</div>
              </span>
              {ms.status !== 'active' ? <span className="badge warn">{tk(`status.member.${ms.status}`)}</span> : <Icon name="chevron" />}
            </button>
          ))}
        </div>
      )}
    </Frame>
  );
}
