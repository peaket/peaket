// 좌석 홀드·판매 확정 모델 기반 시험의 대상(wbs 2.5.5, docs/verification.md §2.4, specs/seat.qnt, BUILD_ORDER PRF-151).
// 운영 코드(inventory 모듈의 RedisSeatStore·DrizzleSeatSales·DrizzleSeatHoldLedger·RedisSeatStreamSource·SeatRebuilder)를 실제 Valkey(노드 하나짜리
// 클러스터 모드)와 PostgreSQL 18 위에 그대로 돌린다. 메서드 이름은 명세의 동작 이름이고, 결과로 시도 상태(명세 Att)를 바꾼다.
// 명세와 운영 코드의 대응(정한 것, BUILD_ORDER PRF-151):
// - hold → RedisSeatStore.hold(홀드 Lua). 명세가 뺀 '방금 놓은 좌석'(rel:{계정})은 걸음마다 지운다. 좌석맵은 UUID 좌석 ID의 MemorySeatMap이다.
// - ttlPasses → 흉내(시각 흐름): 그 시도 홀드 Hash의 exp와 만료 인덱스 점수, 원장 seat_hold.expires_at, 아직 적재하지 않은 HELD 사건의 만료 시각을 과거로.
//   복제본·복제되지 않은 사본에도 같게 한다(시간은 모든 노드에서 흐른다).
// - expire → RedisSeatStore.dueExpiries + expire(만료 Lua). 명세처럼 그 시도의 좌석만 넘긴다.
// - accept → 좌석 확인은 흉내(명세 accept는 접수 때 좌석을 보지만 운영 접수는 보지 않는다): 좌석마다 내 홀드이거나 비어 있는지 읽고, 세대 키의 판 번호 gen(없으면 1)을
//   시도에 적는다. 받으면 운영 경로로 주문을 만든다(DrizzleOrderStore.createOrder → 결제 시도 READY → DrizzleOrderAccepts.accept, seat_gen = 그 판 번호, 작업 행 RESERVE).
//   주문 행은 관측하지 않는다(명세 Db에 없다). 판매 예약 트랜잭션(ReserveTx)이 주문 T7까지 쓰려면 있어야 한다(BUILD_ORDER PRF-165, V-T40 ④).
// - pin → RedisSeatStore.pin(orderGen = 시도에 적은 판 번호. 명세 saleStep은 판 번호가 바뀌어도 시도의 판 번호를 그대로 두고, 운영 Saga도 같다(리뷰 M1:
//   GEN_CHANGED 뒤 주문 seat_gen을 고치지 않고, 묶기가 OK면 그 판 번호를 적는다)). FAILED_HOLD(실패 표시, PRF-165)는 아무것도 쓰지 않은 실패라 명세 pin의 실패 갈래와 같게 FAILED로 둔다. 명세에서는 releaseFailed가 FAILED 시도에만
//   열리고 FAILED에서 ACCEPTED로 돌아가는 걸음이 없어 이 답이 나올 수 없다(나오면 명세가 OK를 내다본 걸음이라 어긋남으로 남는다).
// - saleStep → 운영 판매 예약 트랜잭션 DrizzleSaga.reserve(ReserveTx: seat_rebuild 행 FOR SHARE로 판 번호 대조 → reserveIn → 작업 CONFIRM → T7, BUILD_ORDER PRF-165):
//   명세는 좌석마다 한 걸음이지만 코드는 한 트랜잭션이라 마지막 걸음에 한 번 부르고 중간 걸음은 관측(그 좌석에 커밋된 활성 판매 행이 있는지)만 한다.
//   GEN_CHANGED면 명세처럼 ACCEPTED로 돌아가 묶기부터 다시 한다. 시험 전용 변이(SystemOptions.dropGenCheck, 기본 꺼짐)는 판 번호 대조를 뺀다(V-T40 ④).
//   겹치는 판매 예약 집중 시험(reserveTogether)은 손으로 만든 상태라 주문이 없어 DrizzleSeatSales.reserve를 그대로 부른다.
// - approve → markSold, decline → releasePending, releaseFailed → RedisSeatStore.releaseFailed.
// - relay → Kafka를 건너뛴 적재: 걸음마다 RedisSeatStreamSource.read → routeStreamEntry → toLedgerHoldEvent로 읽어 두고, 끝 사건(RELEASED·EXPIRED)은
//   곧바로 DrizzleSeatHoldLedger.apply(명세 '해제·만료 사건은 제때 적재된다'), HELD는 명세 relay(h) 때 적용한다. 한 번 적재한 시도의 뒤 HELD(묶기의 다시 잡기)는
//   곧바로 적용한다(명세의 원장은 시도 단위다).
// - replicate·promote·loseAll → 회차 슬롯 키 사본(대기열 하네스의 DUMP/RESTORE 방식, 복제 지연 쓰기 하나). Stream·방금 놓은 좌석·멱등 기록은 사본에서 뺀다.
//   loseAll은 회차 슬롯 키를 모두 지우고 회차 목록 s:ctl:events에서도 뺀다.
// - rebuild → SeatRebuilder(DrizzleSeatRebuildSource, RedisSeatStore, MemorySeatMap, 주문 근거 booking DrizzleRebuildOrders, BUILD_ORDER PRF-167).
//   pin이 OK면 운영 Saga처럼 주문 pinned_at을 적는다(DrizzleSaga.recordPinned): 다시 만들기가 결제 접수했고 묶인 주문의 좌석을 되살리는 근거다.
// '쓰기'(복제 지연을 하나 쓰는 걸음)는 명세 Red(준비·판 번호·좌석·보유 수)가 바뀐 걸음이다(재생은 기록의 앞뒤 red로 정한다).
// 경합 시험(SystemOptions.scheduler)은 운영 코드의 Redis 호출(command·evalScript)과 DB 호출(db.execute, transaction의 시작·문장·커밋)을 fast-check 스케줄러의
// 문으로 감싸고, 걸음마다 스케줄러를 직접 돌린다. 문은 호출을 보내기 전에 선다(DB 문장은 서버에서 다른 트랜잭션을 기다릴 수 있어 결과를 붙들면 멈춘다).
// 명세 불변식 ①~⑤를 관측으로 세고(violations), 걸음마다 명세가 그 앞 상태에서 내다본 결과와 운영 코드의 결과를 견준다(경합 걸음은 빼고).
// 명세와 운영이 다르다고 알려진 곳은 known에 남긴다(아래 KNOWN).
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import {
  type CallOptions,
  type Database,
  type DbTransaction,
  ensureOutboxPartitions,
  type HotRedis,
  type RedisScript,
  redisScript,
  requestFingerprint,
  systemClock,
  uuidv7,
} from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { Scheduler } from 'fast-check';
import { DrizzleOrderAccepts, DrizzleOrderStore, DrizzleRebuildOrders, DrizzleSaga, ORDER_SAGA_ACTOR } from '../../src/modules/booking/index.js';
import { accountActor, newOrderInput } from '../order-fixtures.js';
import {
  DrizzleSeatHoldLedger,
  DrizzleSeatRebuildSource,
  DrizzleSeatSales,
  holdFingerprint,
  KEEP_AFTER_SALE_END_MS,
  type LedgerHoldEvent,
  MemorySeatMap,
  RedisSeatStore,
  RedisSeatStreamSource,
  routeStreamEntry,
  SEAT_TOPIC,
  SeatRebuilder,
  type SeatRef,
  seatKeys,
  toLedgerHoldEvent,
} from '../../src/modules/inventory/index.js';
import { compareState, type MState, specNext, type SpecMove } from './spec.js';

export type Phase = 'IDLE' | 'HELD' | 'ACCEPTED' | 'PINNED' | 'RESERVED' | 'SOLD' | 'FAILED' | 'DONE';
/** 명세 Att와 같은 칸 */
export interface Att {
  phase: Phase;
  seats: number[];
  late: boolean;
  ins: number;
  gen: number;
}
/** 명세 SeatR·Red(펜싱 카운터는 TOKEN_TIME_FLOOR가 켜진 범위에서 바뀌지 않아 견주지 않는다) */
export interface SeatR {
  hid: number;
  pinned: boolean;
}
export interface Red {
  ready: boolean;
  gen: number;
  seats: Record<number, SeatR>;
  quota: Record<number, number>;
}
/** 명세 검사 모듈의 범위(상수). 설계 장치(UNIQUE_INDEX 등)는 운영 코드에 다 있어 켠 범위만 받는다(itf.ts scopeOf) */
export interface Scope {
  people: number[];
  seats: number[];
  limit: number;
  attempts: ReadonlyArray<readonly [number, number]>;
  requests: number[][];
  maxFailovers: number;
  fullLoss: boolean;
  promote: boolean;
  failRelease: boolean;
}
export interface Ghost {
  stale: number;
  maxTok: number;
  tokBroken: boolean;
  newest: Map<number, number>;
}
/** purchase DB 관측(명세 Db): 좌석마다 활성 판매 행의 시도, 사람마다 한도 행, HELD를 적재한 시도, 다시 만들기 판 번호 */
export interface DbObs {
  sale: Record<number, number[]>;
  used: Record<number, number>;
  ledger: number[];
  gen: number;
}

/**
 * 알려진 차이(명세를 바꾸지 않고 기록한다, BUILD_ORDER PRF-151 보고):
 * - K1(시간이 지난 뒤 묶인 홀드)·K3(원장 행 없이 되살린 판매 좌석의 holdId가 주문 ID)는 다시 만들기가 주문 기준으로 되살리게 고쳐(BUILD_ORDER PRF-167)
 *   알려진 차이에서 지웠다. 이제 둘 다 위반 검사(다시 만들기 뒤 명세 rebuild와 견줌, 실패 해제 푼 좌석 수)로 본다(docs/verification.md §2.4).
 * - K2 실패한 시도의 아직 풀지 않은 홀드: 명세 다시 만들기는 FAILED 시도를 되살리지 않지만, 원장은 실패를 모르므로(좌석 해제 사건 전) 되살린다.
 *   하네스는 다시 만들기 바로 뒤에 그 시도의 실패 해제를 다시 불러(좌석 해제 사건 소비자의 다시 시도) 명세 상태에 맞춘다.
 */
export type Known = 'K2';

export const hidOf = (k: readonly [number, number]) => k[0] * 10 + k[1];
export const personOf = (h: number) => Math.floor(h / 10);
const accountOf = (p: number) => `0190f3a1-7c2e-7a00-8000-${p.toString(16).padStart(12, '0')}`;
/** 색인 순과 문자 코드 순이 같은 UUID 좌석 ID(seat_sale.seat_id가 uuid) */
export const seatIdOf = (x: number) => `00000000-0000-4000-8000-${x.toString(16).padStart(12, '0')}`;
const DAY = 86_400_000;
/** 시간이 다 된 홀드에 넣는 시각: 아주 먼 과거의 고정 시각(시험 PC와 컨테이너 시계가 달라도 지난 시각이다) */
const PAST_MS = Date.UTC(2020, 0, 1);
const pastMs = () => PAST_MS;
const LAG = 1;
const HOLDER = 'mbt-rebuilder';

// 시험을 고칠 때만: MBT_DEBUG=<파일>이면 걸음마다 한 줄 남긴다
export const debug = (line: string) => {
  if (process.env.MBT_DEBUG) appendFileSync(process.env.MBT_DEBUG, `${line}\n`);
};
/** 함께 돌린 흐름을 모두 끝까지 기다린 뒤(남은 호출이 다음 걸음에 섞이지 않게) 처음 실패를 다시 던진다 */
export async function settleAll<T>(ps: Array<Promise<T>>): Promise<T[]> {
  const rs = await Promise.allSettled(ps);
  const bad = rs.find((r) => r.status === 'rejected');
  if (bad) throw (bad as PromiseRejectedResult).reason;
  return rs.map((r) => (r as PromiseFulfilledResult<T>).value);
}
const text = (b: unknown) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b));

// ---- 호출 감싸기 ----
const PATIENT_MS = 5_000;
/** 호출마다 마감을 적어도 ms로 늘린 HotRedis(바쁜 시험 PC에서 운영 기본 마감 100ms에 걸려 걸음이 실패하지 않게. 마감은 이 시험이 보는 것이 아니다) */
function patient(r: HotRedis, ms: number): HotRedis {
  return Object.assign(Object.create(r) as HotRedis, {
    command: (args: string[], o: CallOptions = {}) => r.command(args, { ...o, deadlineMs: Math.max(o.deadlineMs ?? 0, ms) }),
    evalScript: (sc: RedisScript, ks: string[], as: string[], o: Omit<CallOptions, 'key'> = {}) => r.evalScript(sc, ks, as, { ...o, deadlineMs: Math.max(o.deadlineMs ?? 0, ms) }),
  });
}
/** 스케줄러 문: 호출을 보내기 전에 스케줄러가 풀 때까지 기다린다 */
const gate = (sch: Scheduler, label: string) => sch.schedule(Promise.resolve(label), label);
/** 문을 지나 서버로 간 호출 수(하네스가 다음 문을 풀기 전에 이것이 0이 되기를 기다린다: 입출력 중인 흐름이 뒤처지지 않게) */
export interface Flight {
  n: number;
}
async function flying<T>(f: Flight, p: () => Promise<T>): Promise<T> {
  f.n += 1;
  try {
    return await p();
  } finally {
    f.n -= 1;
  }
}
function gatedRedis(r: HotRedis, sch: Scheduler, f: Flight): HotRedis {
  return Object.assign(Object.create(r) as HotRedis, {
    command: async (args: string[], o?: CallOptions) => {
      await gate(sch, `redis ${args[0]}`);
      return flying(f, () => r.command(args, o));
    },
    evalScript: async (sc: RedisScript, ks: string[], as: string[], o?: Omit<CallOptions, 'key'>) => {
      await gate(sch, 'redis eval');
      return flying(f, () => r.evalScript(sc, ks, as, o));
    },
  });
}
/** DB 문: db.execute, transaction의 시작(BEGIN 전)·문장마다·커밋 전 */
function gatedDb(d: Database, sch: Scheduler, f: Flight): Database {
  const wrapTx = (tx: DbTransaction): DbTransaction =>
    Object.assign(Object.create(tx) as DbTransaction, {
      execute: async (q: Parameters<DbTransaction['execute']>[0]) => {
        await gate(sch, 'db tx.execute');
        return flying(f, () => tx.execute(q));
      },
    });
  const db = Object.assign(Object.create(d.db) as Database['db'], {
    execute: async (q: Parameters<Database['db']['execute']>[0]) => {
      await gate(sch, 'db execute');
      return flying(f, () => d.db.execute(q));
    },
  });
  return {
    db,
    pool: d.pool,
    close: () => d.close(),
    transaction: async <T>(fn: (tx: DbTransaction) => Promise<T>, o?: Parameters<Database['transaction']>[1]) => {
      await gate(sch, 'db begin');
      // BEGIN(연결 받기 포함)과 COMMIT도 서버로 가는 호출로 센다
      f.n += 1;
      let begun = false;
      let committing = false;
      try {
        return await d.transaction(async (tx) => {
          begun = true;
          f.n -= 1;
          const out = await fn(wrapTx(tx));
          await gate(sch, 'db commit');
          committing = true;
          f.n += 1;
          return out;
        }, o);
      } finally {
        if (!begun || committing) f.n -= 1;
      }
    },
  };
}

// ---- 키 사본 ----
interface KeyCopy {
  t: string;
  /** PEXPIRETIME(-1이면 수명 없음) */
  x: number;
  /** 문자열은 16진, 나머지는 원소 목록 */
  v: string | string[];
}
export type Copy = Map<string, KeyCopy>;
const DUMP = redisScript(`
local out = {}
for _, k in ipairs(KEYS) do
  local t = redis.call('TYPE', k)['ok']
  local v = {}
  if t == 'string' then v = {redis.call('GET', k)}
  elseif t == 'hash' then v = redis.call('HGETALL', k)
  elseif t == 'set' then v = redis.call('SMEMBERS', k)
  elseif t == 'list' then v = redis.call('LRANGE', k, 0, -1)
  elseif t == 'zset' then v = redis.call('ZRANGE', k, 0, -1, 'WITHSCORES') end
  out[#out + 1] = {t, redis.call('PEXPIRETIME', k), v}
end
return out
`);
const RESTORE = redisScript(`
local function unhex(h) return (string.gsub(h, '..', function(c) return string.char(tonumber(c, 16)) end)) end
for i = 1, #KEYS do redis.call('DEL', KEYS[i]) end
for _, e in ipairs(cjson.decode(ARGV[1])) do
  local k = KEYS[e.i]
  if e.t == 'string' then redis.call('SET', k, unhex(e.v))
  elseif e.t == 'hash' then for j = 1, #e.v, 2 do redis.call('HSET', k, e.v[j], e.v[j + 1]) end
  elseif e.t == 'set' then for _, m in ipairs(e.v) do redis.call('SADD', k, m) end
  elseif e.t == 'list' then for _, m in ipairs(e.v) do redis.call('RPUSH', k, m) end
  elseif e.t == 'zset' then for j = 1, #e.v, 2 do redis.call('ZADD', k, e.v[j + 1], e.v[j]) end end
  if e.x > 0 then redis.call('PEXPIREAT', k, e.x) end
end
return 1
`);
// 시각 흐름 흉내: 그 holdId의 홀드 Hash exp를 과거로, 만료 인덱스에 있는 좌석은 점수도 과거로. KEYS: 1 expiry, 2.. hold:{색인}. ARGV: 1 holdId, 2 과거 시각, 3.. 색인
const TIME_PASSES = redisScript(`
local n = 0
for i = 2, #KEYS do
  if redis.call('HGET', KEYS[i], 'holdId') == ARGV[1] then
    redis.call('HSET', KEYS[i], 'exp', ARGV[2])
    redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[i + 1])
    n = n + 1
  end
end
return n
`);
// 결제 접수 흉내의 읽기: 세대 키의 epoch·gen, 좌석마다 비트·holdId·owner. KEYS: 1 epoch, 2 bitmap, 3.. hold:{색인}. ARGV: 색인
const ACCEPT_READ = redisScript(`
local ep = redis.call('HMGET', KEYS[1], 'epoch', 'gen')
local out = {ep[1] or '', ep[2] or ''}
for i = 3, #KEYS do
  local bit = redis.call('GETBIT', KEYS[2], ARGV[i - 2])
  local h = redis.call('HMGET', KEYS[i], 'holdId', 'owner')
  out[#out + 1] = {bit, h[1] or '', h[2] or ''}
end
return out
`);

/** 사본에서 볼 키: 회차 슬롯 키 가운데 Stream(하네스가 걸음마다 읽어 둔다)·방금 놓은 좌석(걸음마다 지운다)·멱등 기록(요청마다 새 키)은 뺀다 */
const copied = (k: string) => !k.endsWith(':stream') && !k.includes(':rel:') && !k.includes(':idem:');

export interface SystemOptions {
  /** 경합 시험: 운영 코드의 Redis·DB 호출을 보내는 차례를 fast-check 스케줄러가 정한다(걸음마다 하네스가 스케줄러를 돌린다) */
  scheduler?: Scheduler;
  /**
   * 시험 전용 변이(V-T40 ④, 기본 꺼짐): 판매 예약 트랜잭션(ReserveTx)의 판 번호 대조를 뺀다. 하네스가 ReserveTx를 부르기 직전에 seat_rebuild의 지금 판 번호를 읽어
   * orderGen으로 넘겨 대조가 늘 같다고 보게 한다(운영 코드는 그대로다). 재생이 처음 어긋나는 걸음에서 멈추는지 보는 데만 쓴다
   */
  dropGenCheck?: boolean;
}

/** Outbox 일 파티션은 관측·씨앗용 풀(곧 DB)마다 한 번 만든다(하네스가 운영 경로로 주문을 만들면 주문 사건이 Outbox에 들어간다) */
const outboxReady = new WeakMap<Database, Promise<unknown>>();

interface Buffered {
  h: number;
  ev: LedgerHoldEvent;
}

export class SeatSystem {
  readonly atts = new Map<number, Att>();
  readonly env = { partials: 0, fulls: 0 };
  readonly ghost: Ghost = { stale: 0, maxTok: 0, tokBroken: false, newest: new Map() };
  readonly violations: string[] = [];
  /** 알려진 차이(KNOWN): 걸음 번호, 종류, 내용, 그 차이가 설명하는 칸(spec.ts compareState의 열쇠) */
  readonly known: Array<{ step: number; kind: Known; msg: string; explains: string[] }> = [];
  /** 경합 쌍 걸음 수(무작위 경합 시험이 센다) */
  pairSteps = 0;
  /** 그 가운데 두 판매 예약 걸음을 함께 돌린 수 */
  pairSales = 0;
  /** 그 가운데 같은 좌석이나 같은 사람(한도 행)을 두고 겹친 수 */
  pairSalesOverlap = 0;
  /** 주 노드 승격이 잃은 쓰기 수(경합 쌍 걸음은 쓰기 둘로 센다). 차례대로 도는 실행에서는 승격 수와 같다 */
  lostWrites = 0;
  /** 복제되지 않은 쓰기의 무게(pending과 같은 차례) */
  #pendingW: number[] = [];
  readonly log: string[] = [];
  /** HELD 사건을 적재한 시도(명세 db.ledger) */
  readonly relayed = new Set<number>();
  /** 판매 예약 트랜잭션이 넣은(커밋 전) 좌석의 시도(명세 db.unc. 코드는 한 트랜잭션이라 하네스가 센다) */
  readonly unc = new Map<number, number>();
  /** 회차 슬롯: 지금 주 노드, 복제본, 복제되지 않은 쓰기 */
  current: Copy = new Map();
  replica: Copy = new Map();
  pending: Copy[] = [];
  /** 마지막 걸음 뒤 관측(명령의 check가 동기로 읽는다) */
  obs: { red: Red; rep: Red; db: DbObs } = {
    red: { ready: false, gen: 0, seats: {}, quota: {} },
    rep: { ready: false, gen: 0, seats: {}, quota: {} },
    db: { sale: {}, used: {}, ledger: [], gen: 1 },
  };
  readonly eventId = uuidv7(systemClock);
  /** 예측 검사: 경합 걸음(여러 흐름을 함께 돌림)에서는 앞 상태로 결과를 내다볼 수 없어 끈다 */
  checking = true;

  readonly #raw: HotRedis;
  readonly #redis: HotRedis;
  readonly #admin: Database;
  readonly #scheduler: Scheduler | undefined;
  readonly #flight: Flight = { n: 0 };
  readonly #store: RedisSeatStore;
  readonly #sales: DrizzleSeatSales;
  /** 운영 판매 예약 트랜잭션(ReserveTx, 스케줄러 문을 지나는 풀) */
  readonly #saga: DrizzleSaga;
  /** 결제 접수(주문 만들기, 관측·씨앗용 풀. 명세 accept는 DB를 쓰지 않아 경합 차례에 넣지 않는다) */
  readonly #orderStore: DrizzleOrderStore;
  readonly #accepts: DrizzleOrderAccepts;
  readonly #dropGenCheck: boolean;
  readonly #ledger: DrizzleSeatHoldLedger;
  readonly #rawLedger: DrizzleSeatHoldLedger;
  readonly #rawSource: RedisSeatStreamSource;
  readonly #rebuilder: SeatRebuilder;
  readonly #seatMap = new MemorySeatMap();
  readonly #ids = new Map<number, { holdId: string; orderId: string; psid: string }>();
  readonly #byHold = new Map<string, number>();
  readonly #byOrder = new Map<string, number>();
  readonly #buffer: Buffered[] = [];
  readonly #saleEndsAtMs = Date.now() + 2 * DAY;
  readonly #keepUntilMs = this.#saleEndsAtMs + KEEP_AFTER_SALE_END_MS;
  /** 이번 걸음에 새로 낸 펜싱 토큰(④는 걸음 끝에 본다: 경합 걸음은 답이 오는 차례가 토큰 차례와 다를 수 있다) */
  #stepTokens: number[] = [];
  #rebuildExpect: Record<number, SeatR> | undefined;

  constructor(
    raw: HotRedis,
    db: Database,
    admin: Database,
    readonly scope: Scope,
    o: SystemOptions = {},
  ) {
    this.#raw = patient(raw, PATIENT_MS);
    this.#admin = admin;
    this.#scheduler = o.scheduler;
    this.#redis = o.scheduler ? gatedRedis(this.#raw, o.scheduler, this.#flight) : this.#raw;
    const database = o.scheduler ? gatedDb(db, o.scheduler, this.#flight) : db;
    this.#store = new RedisSeatStore(this.#redis);
    this.#sales = new DrizzleSeatSales(database);
    this.#orderStore = new DrizzleOrderStore({ clock: systemClock });
    this.#saga = new DrizzleSaga({ database, store: this.#orderStore, sales: this.#sales, clock: systemClock });
    this.#accepts = new DrizzleOrderAccepts({ database: admin, store: this.#orderStore, clock: systemClock });
    this.#dropGenCheck = o.dropGenCheck === true;
    this.#ledger = new DrizzleSeatHoldLedger(database);
    this.#rawLedger = new DrizzleSeatHoldLedger(admin);
    this.#rawSource = new RedisSeatStreamSource(this.#raw);
    this.#rebuilder = new SeatRebuilder({
      source: new DrizzleSeatRebuildSource(database),
      target: this.#store,
      seatMap: this.#seatMap,
      holder: HOLDER,
      orders: new DrizzleRebuildOrders(database),
    });
    for (const k of scope.attempts) {
      const h = hidOf(k);
      const ids = { holdId: uuidv7(systemClock), orderId: uuidv7(systemClock), psid: uuidv7(systemClock) };
      this.#ids.set(h, ids);
      this.#byHold.set(ids.holdId, h);
      this.#byOrder.set(ids.orderId, h);
      this.atts.set(h, { phase: 'IDLE', seats: [], late: false, ins: 0, gen: 0 });
    }
    for (const x of scope.seats) this.ghost.newest.set(x, 0);
  }

  att(h: number): Att {
    return this.atts.get(h)!;
  }
  hids(): number[] {
    return [...this.atts.keys()];
  }
  holdIdOf(h: number): string {
    return this.#ids.get(h)!.holdId;
  }
  #ref(x: number): SeatRef {
    return { seatId: seatIdOf(x), index: x - 1, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: x - 1, tierId: 'R' };
  }
  /** 홀드·묶기·해제 입력의 좌석(좌석 ID 오름차순) */
  #refs(l: readonly number[]): SeatRef[] {
    return [...l].sort((a, b) => a - b).map((x) => this.#ref(x));
  }
  get #seatCount(): number {
    return Math.max(...this.scope.seats);
  }

  // ---- 준비 ----
  async init(): Promise<void> {
    let ready = outboxReady.get(this.#admin);
    if (!ready) {
      ready = ensureOutboxPartitions(this.#admin, systemClock);
      outboxReady.set(this.#admin, ready);
    }
    await ready;
    this.#seatMap.put(
      { eventId: this.eventId, layoutVersion: 'mbt', seatCount: this.#seatCount, perAccountLimit: this.scope.limit, saleEndsAtMs: this.#saleEndsAtMs },
      this.scope.seats.map((x) => this.#ref(x)),
    );
    // 판매 열기(세대 키 gen 1 = 명세 RED0)
    await new RedisSeatStore(this.#raw).openSale({ eventId: this.eventId, seatCount: this.#seatCount, keepUntilMs: this.#keepUntilMs });
    this.current = await this.#dumpEvent();
    this.replica = this.current;
    await this.#observe();
  }

  // ---- 사본 ----
  async #scanEvent(all = false): Promise<string[]> {
    const pat = `s:{event:${this.eventId}}:*`;
    const found = new Set<string>();
    let cursor = '0';
    do {
      const [next, items] = (await this.#raw.command(['SCAN', cursor, 'MATCH', pat, 'COUNT', '1000'], { key: seatKeys.epoch(this.eventId) })) as [unknown, unknown[]];
      for (const x of items) found.add(text(x));
      cursor = text(next);
    } while (cursor !== '0');
    return [...found].filter((k) => all || copied(k)).sort();
  }
  async #dump(ks: string[]): Promise<Copy> {
    const out: Copy = new Map();
    if (ks.length === 0) return out;
    const r = (await this.#raw.evalScript(DUMP, ks, [], { binary: true, deadlineMs: 2_000 })) as unknown[][];
    ks.forEach((k, i) => {
      const [t, x, v] = r[i] as [unknown, unknown, unknown[]];
      const type = text(t);
      if (type === 'none') return;
      out.set(k, { t: type, x: Number(x), v: type === 'string' ? (v[0] as Buffer).toString('hex') : v.map(text) });
    });
    return out;
  }
  async #dumpEvent(): Promise<Copy> {
    return this.#dump(await this.#scanEvent());
  }
  async #restore(c: Copy): Promise<void> {
    const ks = [...new Set([...(await this.#scanEvent()), ...c.keys()])];
    if (ks.length === 0) return;
    const spec = [...c.entries()].map(([k, e]) => ({ i: ks.indexOf(k) + 1, t: e.t, x: e.x, v: e.v }));
    await this.#raw.evalScript(RESTORE, ks, [JSON.stringify(spec)], { deadlineMs: 2_000 });
  }
  #field(c: Copy, key: string, field: string): string | null {
    const h = c.get(key);
    if (!h || h.t !== 'hash') return null;
    const xs = h.v as string[];
    for (let i = 0; i < xs.length; i += 2) if (xs[i] === field) return xs[i + 1]!;
    return null;
  }
  /** 사본 하나의 명세 Red. 홀드 Hash의 holdId(또는 다시 만들기가 쓴 주문 ID)로 시도를 찾는다(모르는 값이면 −1) */
  redOf(c: Copy): Red {
    const e = this.eventId;
    const ready = this.#field(c, seatKeys.epoch(e), 'epoch') !== null;
    const gen = ready ? Number(this.#field(c, seatKeys.epoch(e), 'gen') ?? '1') : 0;
    const bm = c.get(seatKeys.bitmap(e));
    const bytes = bm && bm.t === 'string' ? Buffer.from(bm.v as string, 'hex') : Buffer.alloc(0);
    const bit = (i: number) => (i >> 3 < bytes.length ? (bytes[i >> 3]! >> (7 - (i & 7))) & 1 : 0);
    const seats: Record<number, SeatR> = {};
    for (const x of this.scope.seats) {
      if (!bit(x - 1)) {
        seats[x] = { hid: 0, pinned: false };
        continue;
      }
      const hk = seatKeys.hold(e, x - 1);
      const id = this.#field(c, hk, 'holdId') ?? '';
      seats[x] = { hid: this.#byHold.get(id) ?? this.#byOrder.get(id) ?? -1, pinned: this.#field(c, hk, 'pin') === '1' };
    }
    const quota: Record<number, number> = {};
    for (const p of this.scope.people) {
      const q = c.get(seatKeys.quota(e, accountOf(p)));
      quota[p] = q && q.t === 'string' ? Number(Buffer.from(q.v as string, 'hex').toString('utf8')) : 0;
    }
    return { ready, gen, seats, quota };
  }
  sameRed(a: Red, b: Red): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ---- 관측 ----
  async #observe(): Promise<void> {
    const e = this.eventId;
    const q = (s: ReturnType<typeof sql>) => this.#admin.db.execute(s);
    const [sale, used, ledger, gen] = await Promise.all([
      q(sql`select seat_id::text as seat_id, order_id::text as order_id from seat_sale where event_id = ${e}::uuid and status in ('PENDING', 'SOLD')`),
      q(sql`select account_id::text as account_id, used from purchase_quota where event_id = ${e}::uuid`),
      q(sql`select distinct hold_id::text as hold_id from seat_hold where event_id = ${e}::uuid and held_at is not null and hold_id is not null`),
      q(sql`select gen from seat_rebuild where event_id = ${e}::uuid`),
    ]);
    const db: DbObs = { sale: {}, used: {}, ledger: [], gen: gen.rows.length > 0 ? Number((gen.rows[0] as { gen: unknown }).gen) : 1 };
    for (const x of this.scope.seats) db.sale[x] = [];
    for (const r of sale.rows as Array<{ seat_id: string; order_id: string }>) {
      const x = this.scope.seats.find((s) => seatIdOf(s) === r.seat_id);
      if (x !== undefined) db.sale[x]!.push(this.#byOrder.get(r.order_id) ?? -1);
    }
    for (const x of this.scope.seats) db.sale[x]!.sort((a, b) => a - b);
    for (const p of this.scope.people) db.used[p] = 0;
    for (const r of used.rows as Array<{ account_id: string; used: unknown }>) {
      const p = this.scope.people.find((x) => accountOf(x) === r.account_id);
      if (p !== undefined) db.used[p] = Number(r.used);
    }
    db.ledger = (ledger.rows as Array<{ hold_id: string }>).map((r) => this.#byHold.get(r.hold_id) ?? -1).sort((a, b) => a - b);
    this.obs = { red: this.redOf(this.current), rep: this.redOf(this.replica), db };
  }

  /** 걸음 하나를 돌리고, 방금 놓은 좌석을 지우고, Stream을 읽어 두고, 복제 사본을 맞춘 뒤 불변식을 센다. write: 명세가 이 걸음을 좌석 Redis 쓰기로 보는지(재생) */
  /**
   * 걸음 하나를 돌리고, 방금 놓은 좌석을 지우고, Stream을 읽어 두고, 복제 사본을 맞춘 뒤 불변식을 센다. write: 명세가 이 걸음을 좌석 Redis 쓰기로 보는지(재생).
   * move를 주고 경합 걸음이 아니면 앞 상태에서 명세 다음 상태(spec.ts)를 계산해 칸마다 견준다(알려진 차이가 설명하는 칸은 뺀다)
   */
  async step(name: string, f: () => Promise<unknown>, write?: boolean, move?: SpecMove): Promise<void> {
    this.log.push(name);
    debug(`${this.eventId} ${name}`);
    this.#stepTokens = [];
    const pre = move && this.checking ? this.modelState() : undefined;
    const weight = this.checking ? 1 : 2;
    await this.#drive(f().then(() => undefined));
    await this.clearRel();
    await this.#pull();
    const now = await this.#dumpEvent();
    const wrote = write ?? !this.sameRed(this.redOf(now), this.redOf(this.current));
    if (wrote) {
      if (this.pending.length >= LAG) {
        this.replica = this.pending.shift()!;
        this.#pendingW.shift();
      }
      this.pending.push(now);
      this.#pendingW.push(weight);
    }
    this.current = now;
    await this.#observe();
    this.#afterRebuild();
    if (pre) this.#checkModel(pre, move!);
    this.#checkTokens();
    this.#checkInvariants(name);
  }
  /** 쓰기가 아닌 걸음(복제·장애 전환): 사본은 그 걸음이 맞춘다. 앞 상태 pre를 주면 명세 다음 상태와 견준다 */
  async note(name: string, pre?: MState, move?: SpecMove): Promise<void> {
    this.log.push(name);
    debug(`${this.eventId} note ${name}`);
    await this.#observe();
    if (pre && move && this.checking) this.#checkModel(pre, move);
    this.#checkInvariants(name);
  }
  /** 하네스가 아는 지금 상태를 명세 상태 꼴로(관측 + 시도 상태 + 커밋 전 삽입 + 낡은 판매 수) */
  modelState(): MState {
    const unc: Record<number, number> = {};
    for (const x of this.scope.seats) unc[x] = this.unc.get(x) ?? 0;
    const newest: Record<number, number> = {};
    for (const [x, h] of this.ghost.newest) newest[x] = h;
    return structuredClone({
      red: this.obs.red,
      rep: this.obs.rep,
      atts: this.atts,
      db: { ...this.obs.db, unc },
      env: this.env,
      ghost: { stale: this.ghost.stale, newest },
    });
  }
  #checkModel(pre: MState, move: SpecMove): void {
    const want = specNext(this.scope, pre, move);
    const explained = new Set(this.known.filter((k) => k.step === this.log.length).flatMap((k) => k.explains));
    for (const d of compareState(this.scope, want, this.modelState())) if (!explained.has(d.key)) this.#violate(`명세 다음 상태와 다름: ${d.msg}`);
  }

  async #drive(p: Promise<void>): Promise<void> {
    const sch = this.#scheduler;
    if (!sch) return p;
    let done = false;
    const watched = p.finally(() => {
      done = true;
    });
    watched.catch(() => undefined);
    while (!done) {
      if (sch.count() > 0) {
        await sch.waitNext(1);
        await this.#quiet();
      } else await new Promise((r) => setTimeout(r, 1));
    }
    return watched;
  }
  /**
   * 문 하나를 푼 뒤, 서버로 간 호출이 모두 돌아올 때까지(다른 트랜잭션을 기다리며 막힌 DB 문장이 있으면 20ms까지) 기다린다. 그래야 입출력 중인 흐름의 다음 호출도
   * 문 앞에 서서 다음 고르기에 든다(기다리지 않으면 입출력이 없는 흐름의 문만 계속 풀려 차례가 거의 섞이지 않는다)
   */
  async #quiet(): Promise<void> {
    const until = Date.now() + 20;
    await new Promise((r) => setImmediate(r));
    while (this.#flight.n > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }

  /** 방금 놓은 좌석(rel:{계정})을 지운다: 명세가 뺀 30초 대기가 지난 것과 같다. 걸음마다 부르고, 경합 시험은 흐름 안에서도 부른다 */
  async clearRel(): Promise<void> {
    const ks = this.scope.people.map((p) => seatKeys.rel(this.eventId, accountOf(p)));
    await this.#raw.command(['DEL', ...ks], { key: ks[0]! });
  }

  /**
   * Stream을 읽어 둔다(운영 릴레이의 읽기 → 바꾸기 → 원장 사건, Kafka는 건너뜀). 끝 사건과 이미 적재한 시도의 HELD는 곧바로 원장에, 나머지 HELD는 relay(h)까지 둔다.
   * 그룹이 막 사라진 Stream은 첫 읽기가 빈 답이라 빈 답이 두 번 이어질 때까지 읽는다
   */
  async #pull(): Promise<void> {
    let empty = 0;
    while (empty < 2) {
      const got = await this.#rawSource.read(this.eventId, 100);
      if (got.length === 0) {
        empty += 1;
        continue;
      }
      empty = 0;
      for (const entry of got) {
        const r = routeStreamEntry(this.eventId, entry);
        if (r.kind !== 'send' || r.topic !== SEAT_TOPIC) continue;
        const ev = toLedgerHoldEvent(JSON.parse(JSON.stringify(r.message)));
        if (!ev) continue;
        const h = this.#byHold.get(ev.holdId ?? '') ?? this.#byOrder.get(ev.holdId ?? '') ?? -1;
        if (ev.type === 'HELD' && !this.relayed.has(h)) this.#buffer.push({ h, ev });
        else await this.#rawLedger.apply(ev);
      }
      await this.#rawSource.ack(this.eventId, got.map((x) => x.id));
    }
  }

  // ---- 관측으로 본 명세 값 ----
  /** 그 시도가 좌석 Redis(주 노드)에 잡은 좌석. pinned를 주면 그 값인 좌석만 */
  mine(h: number, pinned?: boolean): number[] {
    return this.att(h).seats.filter((x) => this.obs.red.seats[x]!.hid === h && (pinned === undefined || this.obs.red.seats[x]!.pinned === pinned));
  }
  holding(h: number): boolean {
    return this.mine(h).length > 0;
  }
  failovers(): number {
    return this.env.partials + this.env.fulls;
  }
  /** 명세 waitsOn의 막힘: 다른 시도가 넣은(커밋 전) 좌석 */
  blocked(h: number): boolean {
    const a = this.att(h);
    const l = [...a.seats].sort((x, y) => x - y);
    if (a.ins >= l.length) return false;
    const u = this.unc.get(l[a.ins]!) ?? 0;
    return u !== 0 && u !== h;
  }

  #violate(msg: string): void {
    this.violations.push(`${msg} [걸음 ${this.log.length}: ${this.log.slice(-14).join(' → ')}]`);
  }
  #expect(what: string, predicted: unknown, got: unknown): void {
    if (this.checking && JSON.stringify(predicted) !== JSON.stringify(got)) this.#violate(`${what}: 명세가 내다본 ${JSON.stringify(predicted)} ≠ 운영 ${JSON.stringify(got)}`);
  }
  #knownDiff(k: Known, msg: string, explains: string[] = []): void {
    this.known.push({ step: this.log.length, kind: k, msg, explains });
    debug(`${this.eventId} 알려진 차이 ${k}: ${msg}`);
  }
  #token(t: number, seats: readonly number[], h: number): void {
    this.#stepTokens.push(t);
    for (const x of seats) this.ghost.newest.set(x, h);
  }
  #clearNewest(seats: readonly number[], h: number): void {
    for (const x of seats) if (this.ghost.newest.get(x) === h) this.ghost.newest.set(x, 0);
  }
  /** ④ 이번 걸음의 새 토큰은 서로 다르고 앞서 낸 어느 토큰보다 크다 */
  #checkTokens(): void {
    const ts = this.#stepTokens;
    if (ts.length === 0) return;
    if (new Set(ts).size !== ts.length || ts.some((t) => t <= this.ghost.maxTok)) {
      this.ghost.tokBroken = true;
    }
    this.ghost.maxTok = Math.max(this.ghost.maxTok, ...ts);
  }

  // ---- 사람·Saga의 걸음 ----
  async hold(h: number, l: readonly number[]): Promise<string> {
    const a = this.att(h);
    const p = personOf(h);
    const red = this.obs.red;
    const ok = l.every((x) => red.seats[x]!.hid === 0) && red.quota[p]! + l.length <= this.scope.limit;
    const ids = this.#ids.get(h)!;
    const seats = this.#refs(l);
    const r = await this.#store.hold({
      eventId: this.eventId,
      accountId: accountOf(p),
      purchaseSessionId: ids.psid,
      holdId: ids.holdId,
      idempotencyKey: randomUUID(),
      fingerprint: holdFingerprint(seats.map((s) => s.seatId)),
      seats,
      limit: this.scope.limit,
      keepUntilMs: this.#keepUntilMs,
    });
    if (r.kind === 'OK') {
      Object.assign(a, { phase: 'HELD', seats: [...l], late: false, ins: 0, gen: 0 });
      this.#token(r.fencingToken, l, h);
      // 명세처럼 거절된 시도는 좌석 없이 끝난다(409·422)
    } else if (r.kind === 'CONFLICT' || r.kind === 'QUOTA_EXCEEDED') a.phase = 'DONE';
    // 방금 놓은 좌석(명세가 뺀 것)은 걸음 사이에 지우지만, 경합 걸음 안에서 같은 계정의 만료가 먼저 돌면 그 걸음 안에서는 남아 있다(409, 시도는 끝난다)
    else if (r.kind === 'REHOLD_WAIT' && !this.checking) a.phase = 'DONE';
    else throw new Error(`hold(${h}): 뜻밖의 결과 ${r.kind}`);
    this.#expect(`hold(${h}, [${l}])`, ok ? 'OK' : 'REJECTED', r.kind === 'OK' ? 'OK' : 'REJECTED');
    return r.kind;
  }

  async ttlPasses(h: number): Promise<void> {
    const a = this.att(h);
    const holdId = this.holdIdOf(h);
    const past = pastMs();
    const e = this.eventId;
    const idx = a.seats.map((x) => x - 1);
    await this.#raw.evalScript(TIME_PASSES, [seatKeys.expiry(e), ...idx.map((i) => seatKeys.hold(e, i))], [holdId, String(past), ...idx.map(String)]);
    // 복제본·복제되지 않은 사본에도(시간은 모든 노드에서 흐른다)
    for (const c of [this.replica, ...this.pending]) this.#passCopy(c, holdId, past, idx);
    await this.#admin.db.execute(sql`update seat_hold set expires_at = ${new Date(past)}::timestamptz where event_id = ${e}::uuid and hold_id = ${holdId}::uuid and status = 'HELD'`);
    for (const b of this.#buffer) if (b.h === h) b.ev.expiresAtMs = past;
    a.late = true;
  }
  #passCopy(c: Copy, holdId: string, past: number, idx: number[]): void {
    const e = this.eventId;
    for (const i of idx) {
      const hk = seatKeys.hold(e, i);
      const hc = c.get(hk);
      if (!hc || this.#field(c, hk, 'holdId') !== holdId) continue;
      const xs = [...(hc.v as string[])];
      const j = xs.findIndex((x, n) => n % 2 === 0 && x === 'exp');
      if (j >= 0) xs[j + 1] = String(past);
      c.set(hk, { ...hc, v: xs });
      // 좌석마다 바로 앞에 고친 만료 인덱스를 다시 읽는다(앞 좌석의 고침을 덮지 않게)
      const ex = c.get(seatKeys.expiry(e));
      if (ex) {
        const zs = [...(ex.v as string[])];
        const m = zs.findIndex((x, n) => n % 2 === 0 && x === String(i));
        if (m >= 0) zs[m + 1] = String(past);
        c.set(seatKeys.expiry(e), { ...ex, v: zs });
      }
    }
  }

  /** 만료 반복의 한 묶음 가운데 그 시도의 좌석만(명세 expire(h)). h를 주지 않으면 시간이 다 된 좌석을 모두(경합 시험의 만료 반복) */
  async expire(h?: number): Promise<number> {
    const mine = h === undefined ? [] : this.mine(h, false);
    const due = await this.#store.dueExpiries({ eventId: this.eventId, nowMs: Date.now(), limit: 100 });
    const holdId = h === undefined ? undefined : this.holdIdOf(h);
    const own = due.filter((d) => !d.corrupt && d.hold !== null && (holdId === undefined || d.hold.holdId === holdId));
    let released = 0;
    if (own.length > 0) {
      const refs = await this.#seatMap.byIndex(this.eventId, own.map((d) => d.index));
      const r = await this.#store.expire({
        eventId: this.eventId,
        keepUntilMs: this.#keepUntilMs,
        seats: own.map((d, k) => ({ index: d.index, expected: d.hold, ...(refs[k] ? { seat: refs[k] } : {}) })),
      });
      if (r.kind !== 'OK') throw new Error(`expire: 뜻밖의 결과 ${r.kind}`);
      released = r.released;
      const freed = new Set(r.expired.map((x) => x.index + 1));
      for (const d of own) {
        const owner = this.#byHold.get(d.hold!.holdId);
        if (owner !== undefined && freed.has(d.index + 1)) this.#clearNewest([d.index + 1], owner);
      }
    }
    if (h !== undefined) this.#expect(`expire(${h})`, mine.length, released);
    return released;
  }

  /**
   * 결제 접수: 좌석마다 내 홀드이거나 비어 있으면 ACCEPTED, 아니면 DONE(좌석 확인은 흉내). 세대 키의 판 번호를 적는다.
   * 받으면 운영 경로로 주문을 만든다(주문 T1 → 결제 시도 READY → DrizzleOrderAccepts.accept: T3·시도 ACCEPTED·seat_gen·작업 행 RESERVE·T4)
   */
  async accept(h: number): Promise<string> {
    const a = this.att(h);
    const e = this.eventId;
    const ids = this.#ids.get(h)!;
    const idx = a.seats.map((x) => x - 1);
    const r = (await this.#redis.evalScript(ACCEPT_READ, [seatKeys.epoch(e), seatKeys.bitmap(e), ...idx.map((i) => seatKeys.hold(e, i))], idx.map(String))) as unknown[];
    if (text(r[0]) === '') throw new Error(`accept(${h}): 세대 키가 없다(명세는 이때 결제 접수를 미룬다)`);
    const gen = text(r[1]) === '' ? 1 : Number(text(r[1]));
    const ok = (r.slice(2) as unknown[][]).every(([bit, id, owner]) => Number(bit) === 0 || (text(id) === ids.holdId && text(owner) === accountOf(personOf(h))));
    if (ok) await this.#placeOrder(h, gen);
    Object.assign(a, { phase: ok ? 'ACCEPTED' : 'DONE', gen });
    return a.phase;
  }

  /** 시도 h의 주문을 운영 경로로 만들고 접수한다(주문 ID·holdId·구매 세션은 시도의 것, 좌석은 시도의 좌석, 판 번호 gen) */
  async #placeOrder(h: number, gen: number): Promise<void> {
    const ids = this.#ids.get(h)!;
    const accountId = accountOf(personOf(h));
    const items = [...this.att(h).seats].sort((x, y) => x - y).map((x) => ({ seatId: seatIdOf(x), tierId: 'R', sectionId: 'SEC-A', unitPrice: 10_000 }));
    const order = newOrderInput(systemClock, {
      id: ids.orderId,
      eventId: this.eventId,
      accountId,
      holdId: ids.holdId,
      purchaseSessionId: ids.psid,
      items,
      created: { purchaseSessionId: ids.psid, journeyId: uuidv7(systemClock), refMissing: true },
    });
    await this.#admin.transaction((tx) => this.#orderStore.createOrder(tx, order));
    const attemptId = uuidv7(systemClock);
    await this.#admin.db.execute(sql`
      insert into payment_attempt (id, order_id, pg, pg_order_ref, status, created_at)
      values (${attemptId}::uuid, ${ids.orderId}::uuid, 'SIMULATOR', ${ids.orderId}, 'READY', now())`);
    const once = {
      accountRef: accountId,
      operation: 'ACCEPT_PAYMENT',
      key: randomUUID(),
      requestHash: requestFingerprint('POST', `/v1/orders/${ids.orderId}/payment-acceptance`, Buffer.from(ids.orderId, 'utf8')),
    };
    const refs = { pg: 'SIMULATOR' as const, paymentKey: `sim_${ids.orderId.replaceAll('-', '')}` };
    const out = await this.#accepts.accept(once, { orderId: ids.orderId, attemptId, eventId: this.eventId, refs, seatGen: gen, actor: accountActor(accountId) });
    if (out.status !== 'ACCEPTED') throw new Error(`accept(${h}): 주문 접수가 뜻밖의 결과 ${JSON.stringify(out)}`);
  }

  /** 묶기 Lua 한 번(시도에 적은 판 번호로). 시도 상태는 바꾸지 않는다 */
  #pinCall(h: number) {
    const ids = this.#ids.get(h)!;
    return this.#store.pin({
      eventId: this.eventId,
      accountId: accountOf(personOf(h)),
      purchaseSessionId: ids.psid,
      holdId: ids.holdId,
      seats: this.#refs(this.att(h).seats),
      limit: this.scope.limit,
      orderGen: this.att(h).gen,
      keepUntilMs: this.#keepUntilMs,
    });
  }
  /** 재현 시험: Saga가 이미 실패로 끝낸 시도의 묶기 Lua가 늦게 닿는다(시도 상태는 바꾸지 않는다) */
  async lateRegrab(h: number): Promise<string> {
    let kind = '';
    await this.step(`늦은 pin(${h})`, async () => {
      const r = await this.#pinCall(h);
      kind = r.kind;
      if (r.kind === 'OK' && r.fencingToken !== undefined) this.#stepTokens.push(r.fencingToken);
    });
    return kind;
  }

  async pin(h: number): Promise<string> {
    const a = this.att(h);
    const p = personOf(h);
    const red = this.obs.red;
    const free = a.seats.filter((x) => red.seats[x]!.hid === 0);
    const regrab = a.gen === red.gen;
    const ok = a.seats.every((x) => red.seats[x]!.hid === h || (red.seats[x]!.hid === 0 && regrab)) && red.quota[p]! + free.length <= this.scope.limit;
    const r = await this.#pinCall(h);
    if (r.kind === 'OK') {
      Object.assign(a, { phase: 'PINNED', late: false, gen: r.gen });
      if (r.fencingToken !== undefined) this.#token(r.fencingToken, free, h);
      // 운영 Saga처럼 묶기 OK 뒤 주문 pinned_at을 적는다(PRF-167. 주문은 결제 접수 때 만든 그 시도의 주문이다)
      await this.#recordPinned(h);
    } else if (r.kind === 'TAKEN' || r.kind === 'STALE_GEN' || r.kind === 'QUOTA_EXCEEDED') a.phase = 'FAILED';
    // 실패 표시(PRF-165): 이미 실패 해제한 홀드라 아무것도 쓰지 않았다. 명세 pin의 실패 갈래(redKeep, FAILED)와 같다(머리말 pin 줄)
    else if (r.kind === 'FAILED_HOLD') a.phase = 'FAILED';
    else throw new Error(`pin(${h}): 뜻밖의 결과 ${r.kind}`);
    this.#expect(`pin(${h})`, ok ? 'OK' : 'FAILED', r.kind === 'OK' ? 'OK' : 'FAILED');
    return r.kind;
  }

  async #liveConflict(x: number): Promise<boolean> {
    const r = await this.#admin.db.execute(
      sql`select count(*)::int as n from seat_sale where event_id = ${this.eventId}::uuid and seat_id = ${seatIdOf(x)}::uuid and status in ('PENDING', 'SOLD')`,
    );
    return (r.rows[0] as { n: number }).n > 0;
  }
  async #dbGen(): Promise<number> {
    const r = await this.#admin.db.execute(sql`select gen from seat_rebuild where event_id = ${this.eventId}::uuid`);
    return r.rows.length > 0 ? Number((r.rows[0] as { gen: unknown }).gen) : 1;
  }
  #clearUnc(h: number): void {
    for (const [x, u] of this.unc) if (u === h) this.unc.delete(x);
  }
  /** 교착(40P01)은 불변식 ⑤ 위반으로 적고 DEADLOCK, 그 밖의 오류는 그대로 던진다 */
  #deadlockOf(err: unknown, h: number): 'DEADLOCK' {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code !== '40P01') throw err;
    this.#violate(`⑤ 판매 예약 트랜잭션 교착(40P01, 시도 ${h})`);
    return 'DEADLOCK';
  }
  /** 판매 저장소의 예약만(겹치는 판매 예약 집중 시험: 주문이 없는 손으로 만든 상태라 판 번호 대조·T7 없이) */
  async #reserve(h: number): Promise<'RESERVED' | 'QUOTA_EXCEEDED' | 'SEAT_TAKEN' | 'DEADLOCK'> {
    const ids = this.#ids.get(h)!;
    try {
      const r = await this.#sales.reserve({ eventId: this.eventId, orderId: ids.orderId, accountId: accountOf(personOf(h)), seatIds: this.att(h).seats.map(seatIdOf), limit: this.scope.limit });
      return r.status;
    } catch (err) {
      return this.#deadlockOf(err, h);
    }
  }
  /**
   * 운영 판매 예약 트랜잭션(ReserveTx: seat_rebuild FOR SHARE 판 번호 대조 → 판매 행·한도 → 작업 CONFIRM → T7) 한 번. orderGen은 시도의 판 번호다.
   * 변이 dropGenCheck면 지금 seat_rebuild 판 번호(없으면 1)를 orderGen으로 넘겨 대조를 뺀다. ORDER_STATE(주문이 ACCEPTED가 아님)는 하네스 오류라 던진다
   */
  async #reserveTx(h: number): Promise<'RESERVED' | 'QUOTA_EXCEEDED' | 'SEAT_TAKEN' | 'GEN_CHANGED' | 'DEADLOCK'> {
    const ids = this.#ids.get(h)!;
    const a = this.att(h);
    try {
      const orderGen = this.#dropGenCheck ? await this.#dbGen() : a.gen;
      const r = await this.#saga.reserve({
        orderId: ids.orderId,
        eventId: this.eventId,
        accountId: accountOf(personOf(h)),
        seatIds: a.seats.map(seatIdOf),
        limit: this.scope.limit,
        orderGen,
        actor: ORDER_SAGA_ACTOR,
      });
      if (r.status === 'ORDER_STATE') throw new Error(`saleStep(${h}): 판매 예약 트랜잭션이 주문 상태에 막혔다(${r.current ?? '없음'}). 하네스가 주문을 ACCEPTED로 두지 않았다`);
      return r.status;
    } catch (err) {
      return this.#deadlockOf(err, h);
    }
  }
  /**
   * 판매 예약 한 걸음(명세 saleStep): 중간 걸음은 관측만(그 좌석에 커밋된 활성 판매 행이 있으면 판매 예약 트랜잭션을 불러 실패를 받는다), 마지막 걸음은
   * 운영 판매 예약 트랜잭션(판 번호 대조 포함) 한 번. 결과를 명세가 내다본 것과 견준다
   */
  async saleStep(h: number): Promise<string> {
    const a = this.att(h);
    const l = [...a.seats].sort((x, y) => x - y);
    const x = l[a.ins]!;
    const last = a.ins + 1 === l.length;
    const p = personOf(h);
    const conflict = await this.#liveConflict(x);
    const fail = () => {
      Object.assign(a, { phase: 'FAILED', ins: 0 });
      this.#clearUnc(h);
    };
    if (conflict) {
      const r = await this.#reserveTx(h);
      if (r === 'RESERVED') this.#violate(`saleStep(${h}): 좌석 ${x}에 활성 판매 행이 있는데 예약이 됐다`);
      fail();
      return r;
    }
    if (!last) {
      this.unc.set(x, h);
      a.ins += 1;
      return 'INSERTED';
    }
    // 명세가 내다본 결과: 판 번호가 다르면 묶기부터 다시(ACCEPTED), 아니면 한도 안이면 커밋
    const quotaOk = this.obs.db.used[p]! + l.length <= this.scope.limit;
    const predicted = a.gen !== this.obs.db.gen ? 'GEN_CHANGED' : quotaOk ? 'RESERVED' : 'FAILED';
    const r = await this.#reserveTx(h);
    if (r === 'GEN_CHANGED') {
      // 다시 만들기 뒤라 운영 트랜잭션이 되돌렸다(주문 seat_gen은 새 번호가 됐다). 명세처럼 시도의 판 번호는 그대로 두고 묶기부터 다시 한다
      Object.assign(a, { phase: 'ACCEPTED', ins: 0 });
      this.#clearUnc(h);
      this.#expect(`saleStep(${h}) 커밋`, predicted, 'GEN_CHANGED');
      return 'STALE_GEN';
    }
    if (r === 'RESERVED') {
      Object.assign(a, { phase: 'RESERVED', ins: 0 });
      this.#clearUnc(h);
      // ③ 커밋하는 순간 그 좌석의 가장 새 토큰을 받은 다른 시도가 결제 접수 뒤에 살아 있으면 낡은 홀드로 판 것이다
      const live: Phase[] = ['ACCEPTED', 'PINNED', 'RESERVED', 'SOLD'];
      if (l.some((y) => {
        const n = this.ghost.newest.get(y) ?? 0;
        return n !== 0 && n !== h && live.includes(this.att(n).phase);
      })) this.ghost.stale += 1;
    } else fail();
    this.#expect(`saleStep(${h}) 커밋`, predicted, r === 'RESERVED' ? 'RESERVED' : 'FAILED');
    return r;
  }

  /**
   * 경합 집중(겹치는 판매 예약): 손으로 만든 상태. 시도마다 좌석을 주고 묶인 것으로 둔 뒤(좌석 Redis는 보지 않는다) reserve를 함께 부른다.
   * 판 번호 대조는 하지 않는다(모두 지금 판). 시도의 단계를 결과로 바꾼다(RESERVED·FAILED)
   */
  async reserveTogether(orders: ReadonlyArray<readonly [number, readonly number[]]>): Promise<string[]> {
    for (const [h, l] of orders) Object.assign(this.att(h), { phase: 'PINNED', seats: [...l], ins: 0, gen: 1 });
    const outs = await settleAll(orders.map(([h]) => this.#reserve(h)));
    orders.forEach(([h], k) => {
      this.att(h).phase = outs[k] === 'RESERVED' ? 'RESERVED' : 'FAILED';
    });
    return outs;
  }

  /**
   * 경합 집중(마감 초과 묶기 뒤의 실패 해제): Saga가 묶기를 부르고 deadline이 먼저 끝나면(결과 모름) 과금 없이 실패로 끝내고 좌석 해제 사건을 낸다 →
   * 소비자가 실패 해제를 부른다. 묶기 호출은 그 뒤에도 좌석 Redis에 닿을 수 있다(그 결과는 Saga가 보지 않는다). 돌려주는 값: 'TIMEOUT'이면 늦은 묶기의 결과
   */
  async pinWithDeadline(h: number, deadline: Promise<unknown>): Promise<{ saga: 'PINNED' | 'FAILED' | 'TIMEOUT'; late?: string }> {
    const a = this.att(h);
    const call = this.#pinCall(h);
    const first = await Promise.race([call.then((r) => ({ r })), deadline.then(() => null)]);
    if (first === null) {
      a.phase = 'FAILED';
      await this.releaseFailed(h);
      const late = await call;
      if (late.kind === 'OK' && late.fencingToken !== undefined) this.#stepTokens.push(late.fencingToken);
      return { saga: 'TIMEOUT', late: late.kind === 'OK' ? `OK 다시 잡음 ${late.regrabbed}` : late.kind };
    }
    const r = first.r;
    if (r.kind === 'OK') {
      Object.assign(a, { phase: 'PINNED', late: false, gen: r.gen });
      if (r.fencingToken !== undefined) this.#stepTokens.push(r.fencingToken);
      await this.#recordPinned(h);
      return { saga: 'PINNED' };
    }
    a.phase = 'FAILED';
    await this.releaseFailed(h);
    return { saga: 'FAILED' };
  }

  /**
   * 묶기 OK 뒤 주문 판 번호·pinned_at 적기(운영 DrizzleSaga.recordPinned, PRF-167, 리뷰 고침 L5로 한 UPDATE): 운영 Saga처럼 주문의 지금 seat_gen에서
   * 묶기 결과의 판 번호(시도에 적은 gen)로. 결제 접수로 주문을 만든 시도만(집중 시험의 손으로 만든 시도는 주문이 없다)
   */
  async #recordPinned(h: number): Promise<void> {
    const orderId = this.#ids.get(h)!.orderId;
    const placed = await this.#admin.db.execute(sql`select seat_gen from purchase_order where id = ${orderId}::uuid`);
    if (placed.rows.length === 0) return;
    const fromGen = Number((placed.rows[0] as { seat_gen: unknown }).seat_gen);
    if (!(await this.#saga.recordPinned(orderId, fromGen, this.att(h).gen)))
      this.#violate(`pin(${h}): 묶기 OK 뒤 주문 판 번호·pinned_at을 적지 못했다(주문이 ACCEPTED가 아니거나 판 번호가 바뀜)`);
  }

  async approve(h: number): Promise<void> {
    const a = this.att(h);
    const n = await this.#sales.markSold({ eventId: this.eventId, orderId: this.#ids.get(h)!.orderId, seatIds: a.seats.map(seatIdOf) });
    this.#expect(`approve(${h}) 바꾼 행`, a.seats.length, n);
    a.phase = 'SOLD';
  }
  async decline(h: number): Promise<void> {
    const a = this.att(h);
    const n = await this.#sales.releasePending({ eventId: this.eventId, orderId: this.#ids.get(h)!.orderId, seatIds: a.seats.map(seatIdOf), accountId: accountOf(personOf(h)) });
    this.#expect(`decline(${h}) 지운 행`, a.seats.length, n);
    a.phase = 'FAILED';
  }
  async releaseFailed(h: number, holdId?: string): Promise<number> {
    const a = this.att(h);
    const mine = this.mine(h);
    const call = (id: string) =>
      this.#store.releaseFailed({ eventId: this.eventId, accountId: accountOf(personOf(h)), holdId: id, seats: this.#refs(a.seats), keepUntilMs: this.#keepUntilMs });
    const r = await call(holdId ?? this.holdIdOf(h));
    if (r.kind !== 'OK') throw new Error(`releaseFailed(${h}): 뜻밖의 결과 ${r.kind}`);
    const released = r.released;
    this.#clearNewest(mine, h);
    this.#expect(`releaseFailed(${h}) 푼 좌석 수`, mine.length, released);
    return released;
  }

  /** 홀드 원장 적재(명세 relay(h)): 읽어 둔 그 시도의 HELD 사건을 원장에 적용한다 */
  async relay(h: number): Promise<number> {
    await this.#pull();
    const mine = this.#buffer.filter((b) => b.h === h);
    for (const b of mine) await this.#ledger.apply(b.ev);
    for (const b of mine) this.#buffer.splice(this.#buffer.indexOf(b), 1);
    this.relayed.add(h);
    if (this.checking && mine.length === 0) this.#violate(`relay(${h}): 적재할 HELD 사건이 없다`);
    return mine.length;
  }

  // ---- 좌석 Redis 복제·장애 전환·다시 만들기 ----
  replicate(): void {
    this.replica = this.current;
    this.pending = [];
    this.#pendingW = [];
  }
  async promote(): Promise<void> {
    await this.#restore(this.replica);
    this.current = await this.#dumpEvent();
    this.replica = this.current;
    this.pending = [];
    this.env.partials += 1;
    this.lostWrites += this.#pendingW.reduce((n, w) => n + w, 0);
    this.#pendingW = [];
  }
  async loseAll(): Promise<void> {
    const ks = await this.#scanEvent(true);
    for (let i = 0; i < ks.length; i += 100) await this.#raw.command(['DEL', ...ks.slice(i, i + 100)], { key: ks[i]! });
    await this.#raw.command(['SREM', seatKeys.ctlEvents(), this.eventId], { key: seatKeys.ctlEvents() });
    this.current = new Map();
    this.replica = this.current;
    this.pending = [];
    this.#pendingW = [];
    this.env.fulls += 1;
  }
  /** 명세 rebuild가 쓸 좌석(다시 만들기 앞 관측과 시도 상태로): 판매 좌석 먼저, 그다음 적재했고 시간이 다 되지 않은 시도의 좌석 */
  #specRebuild(): Record<number, SeatR> {
    const liveP: Phase[] = ['HELD', 'ACCEPTED', 'PINNED', 'DONE'];
    const live = [...this.relayed].filter((h) => !this.att(h).late && liveP.includes(this.att(h).phase)).sort((a, b) => a - b);
    const out: Record<number, SeatR> = {};
    for (const x of this.scope.seats) {
      const sale = this.obs.db.sale[x]!;
      const owner = live.find((h) => this.att(h).seats.includes(x));
      out[x] = sale.length > 0 ? { hid: Math.min(...sale), pinned: true } : owner !== undefined ? { hid: owner, pinned: false } : { hid: 0, pinned: false };
    }
    return out;
  }
  async rebuild(): Promise<string> {
    this.#rebuildExpect = this.#specRebuild();
    const r = await this.#rebuilder.rebuild(this.eventId, { keepUntilMs: this.#keepUntilMs });
    if (r.result !== 'REBUILT') this.#violate(`rebuild: 세대 키가 없는데 결과가 ${r.result}`);
    // K2: 명세는 실패한 시도의 홀드를 되살리지 않는다. 운영이 되살린 그 좌석은 좌석 해제 사건 소비자가 다시 풀 몫이라 여기서 부른다
    const now = this.redOf(await this.#dumpEvent());
    for (const h of this.hids()) {
      const a = this.att(h);
      const back = a.seats.filter((x) => now.seats[x]!.hid === h && !now.seats[x]!.pinned);
      if (a.phase === 'FAILED' && back.length > 0 && this.#rebuildExpect !== undefined && back.every((x) => this.#rebuildExpect![x]!.hid !== h)) {
        this.#knownDiff('K2', `실패한 시도 ${h}의 좌석 ${back}을 원장에서 되살렸다(실패 해제를 다시 불렀다)`);
        await this.#store.releaseFailed({ eventId: this.eventId, accountId: accountOf(personOf(h)), holdId: this.holdIdOf(h), seats: this.#refs(a.seats), keepUntilMs: this.#keepUntilMs });
      }
    }
    return r.result;
  }
  /** 다시 만들기 걸음 뒤: 되살린 좌석을 명세 rebuild와 견준다(K1은 PRF-167로 알려진 차이에서 지웠다: 어긋나면 위반이다) */
  #afterRebuild(): void {
    const want = this.#rebuildExpect;
    if (!want) return;
    this.#rebuildExpect = undefined;
    for (const x of this.scope.seats) {
      const got = this.obs.red.seats[x]!;
      const w = want[x]!;
      if (got.hid === w.hid && got.pinned === w.pinned) continue;
      if (this.checking) this.#violate(`rebuild 좌석 ${x}: 명세 ${JSON.stringify(w)} ≠ 운영 ${JSON.stringify(got)}`);
    }
  }

  // ---- 불변식(명세 ①~⑤) + 좌석 Redis·DB 안의 일치 ----
  #checkInvariants(name: string): void {
    const { red, db } = this.obs;
    for (const x of this.scope.seats) if (db.sale[x]!.length > 1) this.#violate(`① 좌석 ${x}에 활성 판매 행 ${db.sale[x]!.length}개(${name})`);
    for (const p of this.scope.people) {
      const rows = this.scope.seats.reduce((n, x) => n + db.sale[x]!.filter((h) => personOf(h) === p).length, 0);
      if (rows > this.scope.limit) this.#violate(`② 사람 ${p}의 판매 ${rows}석 > 한도 ${this.scope.limit}(${name})`);
      const sold = this.hids()
        .filter((h) => personOf(h) === p && ['RESERVED', 'SOLD'].includes(this.att(h).phase))
        .reduce((n, h) => n + this.att(h).seats.length, 0);
      if (sold > this.scope.limit) this.#violate(`② 사람 ${p}가 판매 예약·판매한 좌석 ${sold}석 > 한도(${name})`);
      if (db.used[p] !== rows) this.#violate(`한도 행 used ${db.used[p]} ≠ 사람 ${p}의 활성 판매 행 ${rows}(${name})`);
      if (red.ready) {
        const held = this.scope.seats.filter((x) => red.seats[x]!.hid > 0 && personOf(red.seats[x]!.hid) === p).length;
        if (red.quota[p] !== held) this.#violate(`보유 수 ${red.quota[p]} ≠ 사람 ${p}가 잡은 좌석 ${held}(${name})`);
      }
    }
    for (const x of this.scope.seats) if (red.seats[x]!.hid < 0) this.#violate(`좌석 ${x}: 비트는 켜졌는데 홀드 Hash의 시도를 모른다(${name})`);
    if (this.ghost.stale > this.lostWrites) this.#violate(`③ 낡은 홀드로 판매 확정 ${this.ghost.stale}건 > 승격이 잃은 쓰기 ${this.lostWrites}(승격 ${this.env.partials}회, ${name})`);
    if (red.ready && red.gen !== db.gen) this.#violate(`세대 키 판 번호 ${red.gen} ≠ DB 판 번호 ${db.gen}(${name})`);
    if (this.ghost.tokBroken) this.#violate(`④ 새 펜싱 토큰이 앞서 낸 토큰보다 크지 않다(${name})`);
  }
}
