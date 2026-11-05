// 브라우저에서 상태 기계(controller.ts)에 넘길 바깥 값을 만든다(ADR-0207). 시험은 이 파일 대신 가짜 값을 넘긴다.
import { links, ORIGINS } from '../config';
import { createClock } from './clock.ts';
import type { Env } from './controller.ts';
import { createNet, tokenHash } from './net.ts';
import { createStore, type KV } from './store.ts';

function storage(name: 'localStorage' | 'sessionStorage'): KV | null {
  try {
    const s = window[name];
    s.getItem('peaket.probe');
    return s;
  } catch {
    return null;
  }
}

/** 팬 토큰 갱신 한 번(POST /v1/identity/access-tokens). 창끼리 하나씩(Web Locks peaket.refresh, docs/features/identity.md §3) */
async function refresh(): Promise<'ok' | 'rejected' | 'unavailable'> {
  const once = async () => {
    try {
      const r = await fetch(`${ORIGINS.api}/v1/identity/access-tokens`, { method: 'POST', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (r.ok) return 'ok' as const;
      return r.status === 401 ? ('rejected' as const) : ('unavailable' as const);
    } catch {
      return 'unavailable' as const;
    }
  };
  return navigator.locks ? navigator.locks.request('peaket.refresh', once) : once();
}

export function browserEnv(eventId: string): Env {
  const local = storage('localStorage');
  return {
    eventId,
    urls: { queue: ORIGINS.queue, files: ORIGINS.files, event: links.event(eventId), seats: links.seats(eventId), verify: links.verify(eventId) },
    net: createNet((u, i) => fetch(u, i), Date.now),
    store: createStore(eventId, local, storage('sessionStorage'), Date.now, (n) => crypto.getRandomValues(new Uint8Array(n))),
    clock: createClock(local, Date.now),
    deviceNow: Date.now,
    random: Math.random,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = window.setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          window.clearTimeout(t);
          resolve();
        }, { once: true });
      }),
    hidden: () => document.visibilityState === 'hidden',
    online: () => navigator.onLine !== false,
    onWake(cb) {
      const vis = () => {
        if (document.visibilityState === 'visible') cb();
      };
      document.addEventListener('visibilitychange', vis);
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        document.removeEventListener('visibilitychange', vis);
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    navigate: (u) => location.assign(u),
    sha256: tokenHash,
    refresh,
  };
}
