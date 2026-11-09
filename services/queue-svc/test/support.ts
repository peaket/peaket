// 시험 도구: 토큰 코덱, 위험 판정 기록기, 사전 검증 토큰 만들기
import type { Clock } from '@peaket/platform';
import { HmacQueueTokens, QUEUE_TOKEN_KEY_ENV } from '../src/modules/entry/adapters/hmac-tokens.js';
import type { EntryStore, NumberBatchInput, RiskInput, RiskPort, RiskVerdict } from '../src/modules/entry/domain/ports.js';
import { PREVERIFY_TTL_MS, QueueStoreUnavailable, type EventSchedule, type PreverifyClaims } from '../src/modules/entry/domain/queue.js';

export const tokens = HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${Buffer.alloc(32, 3).toString('base64')}` });

export const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000001';
export const OTHER_ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000002';
export const PID = 'pid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** 정본의 deviceId 형식(CSPRNG 128비트, base64url 22자, docs/frontend.md §3.12) */
export const DEVICE = 'AQEBAQEBAQEBAQEBAQEBAQ';
export const JNY = '0190f3a1-7c2e-7a00-8000-0000000000aa';

let n = 0;
/** 시험마다 다른 회차 ID(실제 Valkey를 시험끼리 나눠 쓴다) */
export const newEvent = () => `ev-${process.pid}-${Date.now().toString(36)}-${n++}`;
export const newRequest = () => crypto.randomUUID();

/** 진입 ② 묶음 Lua(numberBatch)를 부를 때마다 회차와 건수를 적는 저장소. fail()이 참이면 그 호출을 일시 장애로 실패시킨다(ADR-0179) */
export type Sent = { eventId: string; n: number };
export function counting(store: EntryStore, sent: Sent[], fail: () => boolean = () => false): EntryStore {
  return new Proxy(store, {
    get(target, k) {
      const f = Reflect.get(target, k) as unknown;
      if (typeof f !== 'function') return f;
      return (...args: unknown[]) => {
        if (k === 'numberBatch') {
          const i = args[0] as NumberBatchInput;
          sent.push({ eventId: i.eventId, n: i.items.length });
          if (fail()) return Promise.reject(new QueueStoreUnavailable(new Error('down')));
        }
        return (f as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** ms 안에 끝나지 않으면 실패한다(묶음을 바로 보내지 않아 매달리는 것을 잡는다) */
export async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${ms}ms 안에 끝나지 않았다`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** 오픈은 1분 전, 공연 시작은 이틀 뒤(판매 종료는 하루 뒤) */
export const openSchedule = (now: number, o: Partial<EventSchedule> = {}): EventSchedule => ({
  opensAtMs: now - 60_000,
  startsAtMs: now + 2 * 24 * 3600_000,
  lobbyShuffle: true,
  openBatch: true,
  ...o,
});

export function preverifyToken(clock: Clock, eventId: string, o: Partial<PreverifyClaims> = {}): string {
  const now = clock.now();
  return tokens.preverify({ e: eventId, a: ACCOUNT, d: DEVICE, i0: now, iat: now, exp: now + PREVERIFY_TTL_MS, jny: JNY, ...o });
}

export function recordingRisk(verdict: RiskVerdict | (() => Promise<RiskVerdict>) = { kind: 'OK' }): RiskPort & { seen: RiskInput[] } {
  const seen: RiskInput[] = [];
  return {
    seen,
    score: async (i) => {
      seen.push(i);
      return typeof verdict === 'function' ? verdict() : verdict;
    },
  };
}
