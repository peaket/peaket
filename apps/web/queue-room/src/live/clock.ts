// 서버 시각 보정(docs/frontend.md §3.3, ADR-0110). 대기실은 응답 본문의 serverTimeMs만 표본으로 쓴다(대기열 파일은 Date를 노출하지 않는다).
// offset = 서버 시각 + 왕복/2 − 받은 시각. 최근 8개 [가정] 가운데 왕복이 가장 짧은 표본을 쓴다. localStorage peaket.clock에 30분 [가정] 둔다.
import type { KV } from './store.ts';

const KEY = 'peaket.clock';
const KEEP = 8;
const TTL_MS = 30 * 60_000;

export interface Clock {
  /** 보정된 서버 시각(밀리초) */
  now(): number;
  /** 요청을 보낸 시각과 받은 시각(이 기기 시계)으로 표본을 더한다 */
  sample(serverTimeMs: unknown, sentAt: number, receivedAt: number): void;
}

export function createClock(local: KV | null, deviceNow: () => number): Clock {
  const samples: { offset: number; rtt: number }[] = [];
  let offset = 0;
  try {
    const raw = local?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as { offsetMs?: unknown; sampledAt?: unknown; rttMs?: unknown }) : null;
    if (v && typeof v.offsetMs === 'number' && typeof v.sampledAt === 'number' && typeof v.rttMs === 'number' && deviceNow() - v.sampledAt <= TTL_MS) {
      offset = v.offsetMs;
      samples.push({ offset: v.offsetMs, rtt: v.rttMs });
    }
  } catch {
    /* 저장소를 못 쓰면 표본만으로 */
  }
  return {
    now: () => deviceNow() + offset,
    sample(serverTimeMs, sentAt, receivedAt) {
      if (typeof serverTimeMs !== 'number' || !Number.isFinite(serverTimeMs) || receivedAt < sentAt) return;
      const rtt = receivedAt - sentAt;
      samples.push({ offset: serverTimeMs + rtt / 2 - receivedAt, rtt });
      while (samples.length > KEEP) samples.shift();
      const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      offset = best.offset;
      try {
        local?.setItem(KEY, JSON.stringify({ offsetMs: Math.round(offset), sampledAt: receivedAt, rttMs: best.rtt }));
      } catch {
        /* 저장 실패는 넘긴다 */
      }
    },
  };
}
