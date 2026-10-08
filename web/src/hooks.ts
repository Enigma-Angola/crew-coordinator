import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

/** Fetches JSON with loading/error state. `stale` turns true when a colleague changes a watched record. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, 'network'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

type ChangeEvent = { entity: string; id: string; version: number | null; actorId: string | null };
const subscribers = new Set<(e: ChangeEvent) => void>();
let source: EventSource | null = null;

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.addEventListener('change', (ev) => {
    try {
      const e = JSON.parse((ev as MessageEvent).data);
      subscribers.forEach((s) => s(e));
    } catch {
      /* ignore */
    }
  });
  source.addEventListener('revoked', () => window.location.assign('/signin'));
  source.onerror = () => {
    source?.close();
    source = null;
    setTimeout(ensureSource, 10_000);
  };
}

/** Notifies when another user changes one of the given entities (ids only — data is re-fetched with scope). */
export function useLiveChanges(match: (e: ChangeEvent) => boolean, selfId: string | undefined) {
  const [changedBy, setChangedBy] = useState<string | null>(null);
  const m = useRef(match);
  m.current = match;
  useEffect(() => {
    ensureSource();
    const fn = (e: ChangeEvent) => {
      if (e.actorId && e.actorId !== selfId && m.current(e)) setChangedBy(e.actorId);
    };
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, [selfId]);
  return { changedBy, clear: () => setChangedBy(null) };
}
