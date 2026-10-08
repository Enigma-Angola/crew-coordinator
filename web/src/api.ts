/** API client. Every state-changing call carries the session's CSRF token. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public details?: any) {
    super(code);
  }
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
export const onAuthProblem = (l: Listener) => {
  authListeners.add(l);
  return () => authListeners.delete(l);
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; raw?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (opts.raw && res.ok) return res as any;
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, json.error ?? `http_${res.status}`, json.details);
    if (err.code === 'reauth_required' || err.code === 'unauthenticated' || err.status === 401) authListeners.forEach((l) => l(err));
    throw err;
  }
  return json as T;
}

/** Downloads a file response (exports, signed links) without exposing it to other tabs. */
export async function download(path: string, opts: { method?: string; body?: unknown } = {}, fallbackName = 'download') {
  const res: Response = await api(path, { ...opts, raw: true });
  const cd = res.headers.get('content-disposition') ?? '';
  const name = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? cd.match(/filename="([^"]+)"/)?.[1] ?? fallbackName);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function loginUrl(p: { idp?: string; returnTo?: string; mfa?: boolean; stepup?: boolean; invitation?: string } = {}) {
  const q = new URLSearchParams();
  if (p.idp) q.set('idp', p.idp);
  q.set('returnTo', p.returnTo ?? window.location.pathname + window.location.search);
  if (p.mfa) q.set('mfa', '1');
  if (p.stepup) q.set('stepup', '1');
  if (p.invitation) q.set('invitation', p.invitation);
  return `/auth/login?${q}`;
}
