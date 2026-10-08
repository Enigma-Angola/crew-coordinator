import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api';
import { useI18n, type Lang } from './i18n';

export interface Me {
  user: { id: string; email: string; displayName: string; language: Lang; timezone: string };
  session: { id: string; idp: string; mfa: boolean; phishingResistant: boolean; recentAuth: boolean; authTime: string; expiresAt: string };
  csrfToken: string;
  memberships: { orgId: string; orgName: string; slug: string; role: string; status: string }[];
  activeOrg: { id: string; name: string; defaultLanguage: Lang; defaultTimezone: string; defaultCurrency: string; mfaRequired: boolean } | null;
  orgBlock: string | null;
  role: string | null;
  supplierId: string | null;
  personnelId: string | null;
  permissions: string[];
}

interface Session {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  can: (p: string) => boolean;
  switchWorkspace: (orgId: string) => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const { setLang, setTimeZone } = useI18n();

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/api/me');
      setCsrf(m.csrfToken);
      setMe(m);
      // The saved per-user preference wins over the browser default.
      setLang(m.user.language);
      setTimeZone(m.user.timezone);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [setLang, setTimeZone]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const switchWorkspace = useCallback(
    async (orgId: string) => {
      await api('/api/me/workspace', { body: { orgId } });
      // A full reload guarantees no data from the previous workspace remains in memory.
      window.location.assign('/');
    },
    [],
  );

  const can = useCallback((p: string) => !!me?.permissions.includes(p), [me]);
  return <Ctx.Provider value={{ me, loading, refresh, can, switchWorkspace }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
