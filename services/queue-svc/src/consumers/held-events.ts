// queue-svc Kafka 소비자의 보류 사건을 대기열 Redis에 둔다(DB 보류 표 held_event를 대신한다, docs/data.md §3 q:{held:<토픽>}, ADR-0214 결정 6).
// 토픽마다 한 슬롯({held:<토픽>})이라 '그 업무 키가 아직 보류 중이면 넣기'를 Lua 하나로 한다(플랫폼 보류 포트 holdIfHeld의 원자성).
// - keys·p:<파티션>: 보류 중인 업무 키(점수 = 넣은 시각). all: 보류 기록 위치(개수 상한을 센다)
// - r:<파티션>:<오프셋>: 위치·eventKey·업무 키·오류 요약·Kafka 키·레코드 시각·머리·넣은 시각. v:<파티션>:<오프셋>: 사건 값(base64). e:<eventKey>: 같은 eventKey를 두 번 넣지 않는 표시
// - 보류 표시는 다시 처리할 때까지 둔다(저절로 지우지 않는다, ADR-0142 '버리지 않는다'). 값도 함께 두되, pid가 실린 탈퇴 사건의 값과 머리만
//   min(purgeBy, withdrawnAt + 5일, 지금 + 7일 [가정])까지 두고, 그 시각들을 읽지 못하면 값·머리 없이 위치만 남긴다(HOT-010 리뷰)
// - 토픽마다 1만 건 [가정]을 넘으면 넣지 않고 일시 실패로 돌려준다(그 파티션이 멈춰 경보로 드러난다. 넘치면 쓰기가 실패하는(noeviction) 클러스터를 채우지 않게)
// 사건 값과 업무 키는 로그·지표에 싣지 않는다(오류 요약만, asvs/delivery.md 14.2.4). 값 읽기(JSON)는 BAS-030이 Avro로 바꾼다.
import { type Clock, type HeldEventInput, type HeldEventStore, type HotRedis, redisScript, systemClock, TransientError } from '@peaket/platform';
import { guard, MAX_PURGE_AFTER_MS, QueueStoreUnavailable } from '../modules/entry/index.js';

/** pid가 실린 값을 두는 가장 긴 시간 [가정](Kafka 보존 7일과 같다) */
export const HELD_VALUE_MAX_MS = 7 * 86_400_000;
/** 토픽마다 보류 기록 수의 상한 [가정] */
export const HELD_MAX_PER_TOPIC = 10_000;
/** 값을 개인정보 기한까지만 두는 토픽(pid가 실려 있다) */
const PII_TOPICS = new Set(['identity.accounts-withdrawn']);

/** 값을 둘지와 그 기한(null이면 다시 처리할 때까지) */
export function heldExpiry(e: HeldEventInput, nowMs: number): { keepValue: boolean; valueUntilMs: number | null } {
  if (e.value === null) return { keepValue: false, valueUntilMs: null };
  if (!PII_TOPICS.has(e.topic)) return { keepValue: true, valueUntilMs: null };
  let purgeBy = Number.NaN;
  let withdrawnAt = Number.NaN;
  try {
    const v = JSON.parse(e.value.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as { purgeBy?: unknown; withdrawnAt?: unknown };
      if (typeof o.purgeBy === 'string') purgeBy = Date.parse(o.purgeBy);
      if (typeof o.withdrawnAt === 'string') withdrawnAt = Date.parse(o.withdrawnAt);
    }
  } catch {
    // 읽지 못한 값: 위치만 남긴다
  }
  if (!Number.isFinite(purgeBy) || !Number.isFinite(withdrawnAt)) return { keepValue: false, valueUntilMs: null };
  const until = Math.min(purgeBy, withdrawnAt + MAX_PURGE_AFTER_MS, nowMs + HELD_VALUE_MAX_MS);
  return until > nowMs ? { keepValue: true, valueUntilMs: until } : { keepValue: false, valueUntilMs: null };
}

const tag = (topic: string) => `{held:${topic}}`;
export const heldKeys = {
  keys: (t: string) => `q:${tag(t)}:keys`,
  part: (t: string, p: number) => `q:${tag(t)}:p:${p}`,
  all: (t: string) => `q:${tag(t)}:all`,
  record: (t: string, p: number, o: bigint) => `q:${tag(t)}:r:${p}:${o}`,
  value: (t: string, p: number, o: bigint) => `q:${tag(t)}:v:${p}:${o}`,
  eventKey: (t: string, k: string) => `q:${tag(t)}:e:${k}`,
};

// KEYS: 1 keys, 2 p:<파티션>, 3 all, 4 r:<위치>, 5 v:<위치>, 6 e:<eventKey>(없으면 쓰지 않음)
// ARGV: 1 지금(ms), 2 값 만료(-2면 값 없음, -1이면 다시 처리할 때까지), 3 업무 키, 4 보류 중일 때만(1/0), 5 상한, 6 eventKey 있음(1/0), 7 위치 '<파티션>:<오프셋>',
//       8 값(base64), 9 기록 칸 JSON 배열([칸, 값, …])
// 돌려주는 값: 'HELD' 넣음, 'NOT_HELD' 보류 중이 아니라 넣지 않음, 'DUP' 같은 위치·eventKey가 이미 있음, 'FULL' 상한
export const HOLD_LUA = `
if ARGV[4] == '1' and not redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 'NOT_HELD' end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'DUP' end
if ARGV[6] == '1' and redis.call('EXISTS', KEYS[6]) == 1 then return 'DUP' end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[5]) then return 'FULL' end
local f = cjson.decode(ARGV[9])
redis.call('HSET', KEYS[4], unpack(f))
if ARGV[2] == '-1' then redis.call('SET', KEYS[5], ARGV[8])
elseif ARGV[2] ~= '-2' then redis.call('SET', KEYS[5], ARGV[8], 'PXAT', ARGV[2]) end
if ARGV[6] == '1' then redis.call('SET', KEYS[6], ARGV[7]) end
redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[3])
redis.call('ZADD', KEYS[2], 'NX', ARGV[1], ARGV[3])
redis.call('ZADD', KEYS[3], 'NX', ARGV[1], ARGV[7])
return 'HELD'
`;
const HOLD = redisScript(HOLD_LUA);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/** 보류 포트의 대기열 Redis 구현. 대기열 Redis 일시 장애와 상한은 TransientError(키 단위 소비자가 그 파티션을 멈추고 늘려 쉬며 다시 한다) */
export class RedisHeldEventStore implements HeldEventStore {
  constructor(
    private readonly redis: HotRedis,
    private readonly clock: Clock = systemClock,
    private readonly max: number = HELD_MAX_PER_TOPIC,
  ) {}

  async heldKeys(topic: string, partition: number): Promise<Set<string>> {
    const k = heldKeys.part(topic, partition);
    const r = (await this.#call(this.redis.command(['ZRANGE', k, '0', '-1'], { key: k }))) as unknown[];
    return new Set((r ?? []).map(str));
  }

  async isHeld(topic: string, businessKey: string): Promise<boolean> {
    const k = heldKeys.keys(topic);
    const sc = await this.#call(this.redis.command(['ZSCORE', k, businessKey], { key: k }));
    return sc !== null && sc !== undefined;
  }

  async hold(e: HeldEventInput): Promise<void> {
    const r = await this.#hold(e, false);
    if (r === 'FULL') throw new TransientError(`보류가 상한(${this.max}건)에 닿아 넣지 못했다`);
  }

  async holdIfHeld(e: HeldEventInput): Promise<boolean> {
    const r = await this.#hold(e, true);
    if (r === 'FULL') throw new TransientError(`보류가 상한(${this.max}건)에 닿아 넣지 못했다`);
    // 같은 위치를 이미 넣었으면 보류 중인 것이다(다시 받은 사건)
    return r === 'HELD' || r === 'DUP';
  }

  async #hold(e: HeldEventInput, onlyIfHeld: boolean): Promise<string> {
    const now = this.clock.now();
    const { keepValue, valueUntilMs } = heldExpiry(e, now);
    const t = e.topic;
    const fields = [
      'partition', String(e.partition),
      'offset', e.offset.toString(),
      'eventKey', e.eventKey ?? '',
      'businessKey', e.businessKey,
      'error', e.error,
      'key', e.key ?? '',
      'timestamp', String(e.timestamp),
      'heldAt', String(now),
      'valueKept', keepValue ? '1' : '0',
      // 머리는 값과 같은 기한이 없으므로 값을 다시 처리할 때까지 두는 토픽만 싣는다
      ...(keepValue && valueUntilMs === null ? ['headers', JSON.stringify(e.headers)] : []),
    ];
    const ks = [
      heldKeys.keys(t),
      heldKeys.part(t, e.partition),
      heldKeys.all(t),
      heldKeys.record(t, e.partition, e.offset),
      heldKeys.value(t, e.partition, e.offset),
      heldKeys.eventKey(t, e.eventKey ?? ''),
    ];
    const args = [
      String(now),
      !keepValue ? '-2' : valueUntilMs === null ? '-1' : String(valueUntilMs),
      e.businessKey,
      onlyIfHeld ? '1' : '0',
      String(this.max),
      e.eventKey ? '1' : '0',
      `${e.partition}:${e.offset}`,
      keepValue ? e.value!.toString('base64') : '',
      JSON.stringify(fields),
    ];
    return str(await this.#call(this.redis.evalScript(HOLD, ks, args)));
  }

  /** 대기열 Redis 일시 장애는 TransientError로 바꾼다(그 밖의 오류는 그대로) */
  async #call<T>(p: Promise<T>): Promise<T> {
    try {
      return await guard(p);
    } catch (err) {
      if (err instanceof QueueStoreUnavailable) throw new TransientError('대기열 Redis를 잠시 쓸 수 없어 보류 기록을 다루지 못했다', { cause: err });
      throw err;
    }
  }
}

/** 토픽마다 보류 중인 기록 수(consumer_held_events, 30초마다 잰다) */
export function redisHeldCounts(redis: HotRedis, topics: readonly string[]): () => Promise<Map<string, number>> {
  return async () => {
    const out = new Map<string, number>();
    for (const t of topics) {
      const k = heldKeys.all(t);
      out.set(t, Number(await guard(redis.command(['ZCARD', k], { key: k }))));
    }
    return out;
  };
}
