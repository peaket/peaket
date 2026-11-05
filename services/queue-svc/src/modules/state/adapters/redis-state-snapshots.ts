// 회차 슬롯 Lua 하나로 대기 상태 파일에 쓸 값을 읽는다(docs/features/queue-admission.md §4 '대기 상태 파일의 첫 구현', docs/data.md §3).
// 빠진 번호 비트맵은 바이트 값이라 글자로 풀지 않고 받는다(binary). 100만 번호면 125KB다.
// 같은 Lua에서 notice의 판매 상태 칸과 ctl의 입장 일시정지를 읽는다(같은 회차 슬롯, HOT-010, ADR-0214). 전체 범위 공지는 다른 슬롯이라 따로 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys, PLATFORM_SCOPE, QUEUE_REDIS } from '../../entry/index.js';
import type { StateSnapshots } from '../domain/ports.js';
import { CALLS_TAIL, LOG_TAIL, type NoticeFields, type PlatformNotice, type StateSnapshot } from '../domain/state.js';

// seq·serving, 비트맵의 0번째 바이트부터 seq가 든 바이트까지, 건너뛴 구간 전체, serving_log·calls의 끝(점수 = 번호라 끝이 가장 늦은 것)
const SNAPSHOT = redisScript(`
local seq = tonumber(redis.call('GET', KEYS[1]) or '0')
local serving = tonumber(redis.call('GET', KEYS[2]) or '0')
local bits = redis.call('GETRANGE', KEYS[3], 0, math.floor(seq / 8))
local skipped = redis.call('LRANGE', KEYS[4], 0, -1)
local log = redis.call('ZRANGE', KEYS[5], -tonumber(ARGV[1]), -1, 'WITHSCORES')
local calls = redis.call('ZRANGE', KEYS[6], -tonumber(ARGV[2]), -1, 'WITHSCORES')
local notice = redis.call('HMGET', KEYS[7], 'saleState', 'soldOutTiers', 'paused', 'suspended', 'banner', 'remainingSeats', 'seatsAtMs', 'avgTicketsPerOrder')
local admit = redis.call('HMGET', KEYS[8], 'admitPaused', 'admitPausedUntil')
return {seq, serving, bits, skipped, log, calls, notice, admit}
`);

/** 큰 비트맵을 읽으므로 호출 마감을 늘린다 [가정] */
const SNAPSHOT_DEADLINE_MS = 500;
const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
/** 없는 칸(nil)은 null로 온다 */
const opt = (v: unknown): string | undefined => (v === null || v === undefined || v === false ? undefined : text(v));

/** 매진 등급 칸(JSON 배열). 모양이 틀리면 없는 것으로 본다(쓰는 쪽 버그로 파일 전체를 망치지 않게) */
function tiersOf(v: string | undefined): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? a.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** 0 이상 정수 글(남은 좌석 수·셈 시각). 모양이 틀리면 없는 것으로 본다 */
const count = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : undefined);
/** 유한한 수 글(평균 구매 매수). 범위는 파일을 만들 때 본다 */
const decimal = (v: string | undefined): number | undefined => {
  const n = v === undefined || v.trim() === '' ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** notice의 [saleState, soldOutTiers, paused, suspended, banner, remainingSeats, seatsAtMs, avgTicketsPerOrder] */
function noticeOf(r: unknown): NoticeFields {
  const [saleState, tiers, paused, suspended, banner, left, at, avg] = ((r as unknown[]) ?? []).map(opt);
  const remainingSeats = count(left);
  const seatsAtMs = count(at);
  const avgTicketsPerOrder = decimal(avg);
  return {
    ...(saleState ? { saleState } : {}),
    soldOutTiers: tiersOf(tiers),
    paused: paused === '1',
    suspended: suspended === '1',
    ...(banner ? { banner } : {}),
    ...(remainingSeats !== undefined ? { remainingSeats } : {}),
    ...(seatsAtMs !== undefined ? { seatsAtMs } : {}),
    ...(avgTicketsPerOrder !== undefined ? { avgTicketsPerOrder } : {}),
  };
}

/** [멤버, 점수, 멤버, 점수, …] */
function pairs(v: unknown): [string, number][] {
  const a = (v as unknown[]) ?? [];
  const out: [string, number][] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push([text(a[i]), Number(text(a[i + 1]))]);
  return out;
}

@Injectable()
export class RedisStateSnapshots implements StateSnapshots {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async read(eventId: string): Promise<StateSnapshot> {
    const e = eventId;
    const ks = [keys.seq(e), keys.serving(e), keys.removed(e), keys.skipped(e), keys.servingLog(e), keys.calls(e), keys.notice(e), keys.ctl(e)];
    const r = (await guard(this.redis.evalScript(SNAPSHOT, ks, [String(LOG_TAIL), String(CALLS_TAIL)], { binary: true, deadlineMs: SNAPSHOT_DEADLINE_MS }))) as unknown[];
    const bits = r[2];
    const [admitPaused, admitUntil] = ((r[7] as unknown[]) ?? []).map(opt);
    const until = admitUntil === undefined ? null : Number(admitUntil);
    return {
      notice: noticeOf(r[6]),
      admit: { paused: admitPaused === '1', untilMs: until !== null && Number.isFinite(until) ? until : null },
      seq: Number(r[0]),
      serving: Number(r[1]),
      removed: Buffer.isBuffer(bits) ? new Uint8Array(bits) : new Uint8Array(0),
      // 건너뛴 구간 줄: {시작}:{끝}:{그때까지의 세대}
      skipped: ((r[3] as unknown[]) ?? []).flatMap((line) => {
        const m = /^(\d+):(\d+):\d+$/.exec(text(line));
        return m ? [{ start: Number(m[1]), end: Number(m[2]) }] : [];
      }),
      // serving_log: 멤버 = 칸(초), 점수 = 그 칸의 마지막 serving
      servingLog: pairs(r[4])
        .map(([slot, serving]) => ({ slot: Number(slot), serving }))
        .sort((a, b) => a.slot - b.slot),
      // calls: 멤버 = {전진 시각(밀리초)}:{유효 번호 수}, 점수 = 그 전진의 마지막 번호
      calls: pairs(r[5]).flatMap(([member, last]) => {
        const m = /^(\d+):\d+$/.exec(member);
        return m ? [{ atMs: Number(m[1]), last }] : [];
      }),
    };
  }

  async readPlatform(): Promise<PlatformNotice> {
    const k = keys.notice(PLATFORM_SCOPE);
    const r = await guard(this.redis.command(['HMGET', k, 'paused', 'suspended', 'banner'], { key: k }));
    const [paused, suspended, banner] = ((r as unknown[]) ?? []).map(opt);
    return { paused: paused === '1', suspended: suspended === '1', ...(banner ? { banner } : {}) };
  }
}
