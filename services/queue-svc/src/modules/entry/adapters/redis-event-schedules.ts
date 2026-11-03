// 회차 일정·정렬 설정 사본(q:{event:E}:cfg, docs/data.md §3)을 읽는다. 진입 경로가 공연 DB에 기대지 않게 대기열 Redis에 두고,
// 파드 메모리에 1초 [가정] 둔다. 쓰는 쪽은 판매 승인(BUILD_ORDER LCH-080)이다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, type HotRedis, redisScript } from '@peaket/platform';
import type { EventSchedules } from '../domain/ports.js';
import type { EventSchedule } from '../domain/queue.js';
import { QUEUE_REDIS, guard, keys } from './redis-entry-store.js';
import { SCHEDULE_LUA } from './entry-lua.js';

export const SCHEDULE_CACHE_MS = 1_000;
const SCHEDULE = redisScript(SCHEDULE_LUA);
/** 캐시에 두는 회차 수의 상한 [가정]. 넘으면 가장 오래 둔 것부터 지운다(동시에 판매하는 회차는 이보다 훨씬 적다) */
export const SCHEDULE_CACHE_MAX = 1_000;

function fieldsOf(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = String(raw[i + 1]);
    return o;
  }
  if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  return {};
}

const int = (v: string | undefined): number | null => (v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);
const flag = (v: string | undefined): boolean | null => (v === '1' ? true : v === '0' ? false : null);

/** 사본 값을 읽는다. 칸이 빠졌거나 형이 틀리면 null(열리지 않은 회차로 본다) */
export function parseSchedule(raw: unknown): EventSchedule | null {
  const f = fieldsOf(raw);
  const opensAtMs = int(f.opensAtMs);
  const startsAtMs = int(f.startsAtMs);
  const lobbyShuffle = flag(f.lobbyShuffle);
  const openBatch = flag(f.openBatch);
  if (opensAtMs === null || startsAtMs === null || lobbyShuffle === null || openBatch === null) return null;
  // 둘 다 끈 조합은 받지 않는다(ADR-0118, 공연 등록 422·DB CHECK)
  if (!lobbyShuffle && !openBatch) return null;
  // 묶음 구간 길이는 선택 칸이다(없으면 2초 [가정], 있으면 1~60초만 받는다)
  const windowMs = f.batchWindowMs === undefined ? undefined : int(f.batchWindowMs);
  if (windowMs === null || (windowMs !== undefined && (windowMs < 1 || windowMs > 60_000))) return null;
  return { opensAtMs, startsAtMs, lobbyShuffle, openBatch, ...(windowMs !== undefined ? { batchWindowMs: windowMs } : {}) };
}

@Injectable()
export class RedisEventSchedules implements EventSchedules {
  // 있는 회차만 둔다. 없는 회차까지 두면 형식만 맞는 무작위 회차 ID로 파드 메모리를 키울 수 있다(2026-11-03 새 맥락 리뷰)
  readonly #cache = new Map<string, { at: number; value: EventSchedule }>();

  constructor(
    @Inject(QUEUE_REDIS) private readonly redis: HotRedis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(eventId: string): Promise<EventSchedule | null> {
    const now = this.clock.monotonicMs();
    const hit = this.#cache.get(eventId);
    if (hit && now - hit.at < SCHEDULE_CACHE_MS) return hit.value;
    // 읽으면서 세대 키를 맞춘다(없으면 쓰고, 오픈 전에 주 노드가 바뀌었으면 바꾼다, ADR-0181)
    const value = parseSchedule(await guard(this.redis.evalScript(SCHEDULE, [keys.cfg(eventId), keys.epoch(eventId), keys.seq(eventId)], [])));
    this.#cache.delete(eventId);
    if (value === null) return null;
    this.#cache.set(eventId, { at: now, value });
    while (this.#cache.size > SCHEDULE_CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
    return value;
  }

  cachedForTest(): number {
    return this.#cache.size;
  }
}
