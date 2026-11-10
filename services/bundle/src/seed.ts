// 측정 무대의 회차 열기(BUILD_ORDER PRF-215, docs/verification.md §3.9 'v1 경로'). core-svc 판매 승인(BUILD_ORDER LCH-080)이 없는 local·ci 무대에서
// 실행 도구(loadtest/run.mjs v1)가 실행마다 새 회차를 열 때 합본 파드 안에서 부른다: node dist/seed-cli.js '<JSON>'(seed-cli.ts)
// - 합본과 같은 서비스별 환경 파일(PEAKET_BUNDLE_ENV_DIR)에서 대기열·좌석 Redis와 purchase DB 주소를 읽는다(따로 비밀을 두지 않는다).
// - 대기열 Redis: 회차 일정 사본 q:{event:E}:cfg(오픈·공연 시작 시각, 로비 없음·오픈 직후 묶음, 묶음 구간, 좌석맵 판, 판 번호 1)과 수명(공연 시작 시각),
//   입장 제어가 읽는 회차 목록 q:{admission}:events(docs/data.md §3).
// - 좌석 Redis: 운영 코드와 같은 판매 열기(RedisSeatStore.openSale, 수명은 판매 종료 + 1일)와, purchase DB의 다시 만들기 표시(markOpened).
// - 좌석맵 판 파일({eventId}.json)은 실행 도구가 같은 내용으로 kind 노드 폴더에 먼저 둔다(이 스크립트는 파일을 쓰지 않는다).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLE_ENVS, parseEnvFile } from './bundle.js';

/** 회차 ID: 소문자 UUIDv7(seat_hold 파티션이 회차 ID 범위로 나뉘어 지금 만든 v7이어야 한다, docs/data.md) */
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 판매 종료 = 공연 시작 − 24시간(docs/features/queue-admission.md §3, admission-ctrl plan.ts) */
export const SALE_END_BEFORE_START_MS = 24 * 3600_000;

export interface SeedRequest {
  eventId: string;
  opensAtMs: number;
  startsAtMs: number;
  seatCount: number;
  /** 오픈 직후 묶음 구간(1~60,000ms) */
  batchWindowMs: number;
  layoutVersion: number;
  /**
   * 시험 회차의 결제사 승인 상한(초당 건수). 주면 일정 사본에 결제사 묶음(pgKey·pgTps, ADR-0226)을 두어 입장 제어가 그 속도로 부른다(동시 입장 목표 상한은 그 값 × 90).
   * K1이 v0의 '입장 초당 N명'을 같은 속도로 재현할 때만 쓴다(docs/verification.md §3.9 'K1의 입장 속도'). 없으면 결제사 상한을 걸지 않는다
   */
  pgTps?: number;
  /**
   * 결제사 묶음 이름(pgTps와 함께만, 영문·숫자·_- 1~32자). 실행 도구는 실행마다 `lt-<실행 꼬리표>`를 준다. 입장 제어는 같은 묶음 회차끼리 입장 속도를 나누므로
   * 실행 사이에 이름을 같이 쓰면 같은 무대에 남은 앞 실행의 회차가 다음 실행의 입장을 덜어 간다(코드 리뷰 H1)
   */
  pgKey?: string;
}

const int = (name: string, v: unknown, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) throw new RangeError(`${name}는 ${lo}~${hi}의 정수다`);
  return v;
};

/** 요청을 검사한다(틀리면 RangeError). 공연 시작은 오픈보다 24시간 넘게 뒤여야 한다(판매 종료가 오픈 뒤) */
export function parseSeedRequest(raw: unknown): SeedRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RangeError('시드 요청은 JSON 객체다');
  const o = raw as Record<string, unknown>;
  const allowed = new Set(['eventId', 'opensAtMs', 'startsAtMs', 'seatCount', 'batchWindowMs', 'layoutVersion', 'pgTps', 'pgKey']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new RangeError(`시드 요청의 모르는 칸: ${k}`);
  if (typeof o.eventId !== 'string' || !EVENT_ID.test(o.eventId)) throw new RangeError('eventId는 소문자 UUIDv7이다');
  const opensAtMs = int('opensAtMs', o.opensAtMs, 1, 9_999_999_999_999);
  const startsAtMs = int('startsAtMs', o.startsAtMs, 1, 9_999_999_999_999);
  if (startsAtMs - SALE_END_BEFORE_START_MS <= opensAtMs) throw new RangeError('startsAtMs는 opensAtMs + 24시간보다 뒤다(판매 종료가 오픈 뒤여야 한다)');
  if ((o.pgTps === undefined) !== (o.pgKey === undefined)) throw new RangeError('pgKey와 pgTps는 함께 준다(결제사 묶음)');
  if (o.pgKey !== undefined && (typeof o.pgKey !== 'string' || !PG_KEY.test(o.pgKey))) throw new RangeError('pgKey는 영문·숫자·_- 1~32자다');
  return {
    eventId: o.eventId,
    opensAtMs,
    startsAtMs,
    seatCount: int('seatCount', o.seatCount, 1, 1_000_000),
    batchWindowMs: int('batchWindowMs', o.batchWindowMs, 1, 60_000),
    layoutVersion: int('layoutVersion', o.layoutVersion, 1, 4_294_967_295),
    ...(o.pgTps === undefined ? {} : { pgTps: int('pgTps', o.pgTps, 1, 100_000), pgKey: o.pgKey as string }),
  };
}

/** 결제사 묶음 이름 꼴(admission-ctrl redis-leader-store.ts pgOf와 같다) */
const PG_KEY = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 회차 일정 사본의 칸(로비 없음·오픈 직후 묶음, docs/verification.md §3.9 'K1의 로비 없음'). 결제사 묶음(pgKey·pgTps)은 pgTps를 줄 때만 둔다
 * (입장 속도와 동시 입장 목표 상한을 낮춘다, §3.9 'K1의 입장 속도')
 */
export function scheduleFields(r: SeedRequest): string[] {
  const base = ['opensAtMs', String(r.opensAtMs), 'startsAtMs', String(r.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'batchWindowMs', String(r.batchWindowMs), 'layoutVersion', String(r.layoutVersion), 'rev', '1'];
  return r.pgTps === undefined || r.pgKey === undefined ? base : [...base, 'pgKey', r.pgKey, 'pgTps', String(r.pgTps)];
}

export const queueKeys = {
  cfg: (e: string) => `q:{event:${e}}:cfg`,
  events: 'q:{admission}:events',
};

export interface SeedResult {
  eventId: string;
  saleEndsAtMs: number;
  seatEpoch: number;
  created: boolean;
}

/** Redis에 붙는 시간 한도(실행 도구의 v0 관리 스크립트와 같은 30초, loadtest/run.mjs ADMIN_REDIS_STARTUP_MS, 코드 리뷰 M4) */
export const SEED_STARTUP_TIMEOUT_MS = 30_000;

/** 환경 파일 둘에서 대기열·좌석 Redis와 purchase DB 주소 */
async function stageStores(envDir: string, read: (p: string) => Promise<string>) {
  const queueEnv = parseEnvFile(await read(join(envDir, 'queue-svc.env')), 'queue-svc.env');
  const purchaseEnv = parseEnvFile(await read(join(envDir, 'purchase-svc.env')), 'purchase-svc.env');
  const need = (env: Record<string, string>, name: string) => {
    const v = env[name];
    if (!v) throw new Error(`환경 파일에 ${name}가 없다`);
    return v;
  };
  return { queueUrl: need(queueEnv, 'PEAKET_QUEUE_REDIS_URL'), seatUrl: need(purchaseEnv, 'PEAKET_SEAT_REDIS_URL'), databaseUrl: need(purchaseEnv, 'PEAKET_DATABASE_URL') };
}

/**
 * 진행 중인 시험 회차(입장 제어의 회차 목록 q:{admission}:events에서 점수(공연 시작 시각)가 지금보다 뒤인 것). 실행 도구가 시작 전에 보고,
 * 다른 실행의 회차가 남아 있으면 거절한다(같은 무대의 회차끼리 입장 제어를 나눠 쓰지 않게, 코드 리뷰 H1)
 */
export async function activeEvents(nowMs: number, o: { envDir: string; read?: (p: string) => Promise<string> }): Promise<string[]> {
  const { createHotRedis } = await import('@peaket/platform');
  const { queueUrl } = await stageStores(o.envDir, o.read ?? ((p: string) => readFile(p, 'utf8')));
  const queue = await createHotRedis({ url: queueUrl, startupTimeoutMs: SEED_STARTUP_TIMEOUT_MS });
  try {
    const raw = await queue.command(['ZRANGEBYSCORE', queueKeys.events, `(${Math.floor(nowMs)}`, '+inf'], { key: queueKeys.events });
    return (Array.isArray(raw) ? raw : []).map(String).sort();
  } finally {
    await queue.close();
  }
}

/**
 * queue-svc의 일정 사본 캐시(SCHEDULE_CACHE_MS 1초, services/queue-svc/src/modules/entry/adapters/redis-event-schedules.ts)보다 넉넉히 기다리는 시간.
 * 사본을 지우기 전에 읽은 요청이 그 뒤에 회차를 목록에 다시 넣는 것을 기다려 지운다
 */
export const CLOSE_SETTLE_MS = 1_500;

/**
 * 시험 회차를 끝낸다: 대기열 일정 사본(q:{event:E}:cfg)을 지우고, 입장 제어의 회차 목록과 좌석 판매 목록(s:ctl:events)에서 뺀다. 실행 도구가 기록을 모두 읽은 뒤
 * 정리 때 부른다(코드 리뷰 H1). queue-svc는 사본을 읽을 때마다(대기 상태 파일 매초 생성·셔플 커밋 일꾼·요청) 회차를 목록에 다시 넣으므로, 사본을 먼저 지우고
 * 그 캐시가 지난 뒤 목록에서 빼고 돌아오지 않았는지 본다. 좌석 키는 수명으로 사라진다. 돌려준 값은 각 목록에서 뺀 수(0이면 이미 없었다)
 */
export async function closeEvent(eventId: string, o: { envDir: string; read?: (p: string) => Promise<string>; settleMs?: number }): Promise<{ queue: number; seat: number }> {
  if (!EVENT_ID.test(eventId)) throw new RangeError('eventId는 소문자 UUIDv7이다');
  const { createHotRedis } = await import('@peaket/platform');
  const { queueUrl, seatUrl } = await stageStores(o.envDir, o.read ?? ((p: string) => readFile(p, 'utf8')));
  const queue = await createHotRedis({ url: queueUrl, startupTimeoutMs: SEED_STARTUP_TIMEOUT_MS });
  const seat = await createHotRedis({ url: seatUrl, startupTimeoutMs: SEED_STARTUP_TIMEOUT_MS });
  try {
    const cfg = queueKeys.cfg(eventId);
    await queue.command(['DEL', cfg], { key: cfg });
    await new Promise((r) => setTimeout(r, o.settleMs ?? CLOSE_SETTLE_MS));
    let q = 0;
    for (let i = 0; i < 3; i += 1) {
      q = Math.max(q, Number(await queue.command(['ZREM', queueKeys.events, eventId], { key: queueKeys.events })));
      await new Promise((r) => setTimeout(r, o.settleMs ?? CLOSE_SETTLE_MS));
      if ((await queue.command(['ZSCORE', queueKeys.events, eventId], { key: queueKeys.events })) === null) break;
      if (i === 2) throw new Error(`회차 ${eventId}가 목록에 다시 들어왔다(일정 사본을 지운 뒤에도)`);
    }
    const t = Number(await seat.command(['SREM', 's:ctl:events', eventId], { key: 's:ctl:events' }));
    return { queue: q, seat: t };
  } finally {
    await Promise.allSettled([queue.close(), seat.close()]);
  }
}

/** 시드를 쓴다(환경 파일 폴더는 합본과 같다) */
export async function seed(r: SeedRequest, o: { envDir: string; read?: (p: string) => Promise<string> }): Promise<SeedResult> {
  const stores = await stageStores(o.envDir, o.read ?? ((p: string) => readFile(p, 'utf8')));
  const { createDatabase, createHotRedis } = await import('@peaket/platform');
  const { DrizzleSeatRebuildSource, KEEP_AFTER_SALE_END_MS, RedisSeatStore } = await import('@peaket/purchase-svc/stage');
  const saleEndsAtMs = r.startsAtMs - SALE_END_BEFORE_START_MS;
  const queue = await createHotRedis({ url: stores.queueUrl, startupTimeoutMs: SEED_STARTUP_TIMEOUT_MS });
  const seat = await createHotRedis({ url: stores.seatUrl, startupTimeoutMs: SEED_STARTUP_TIMEOUT_MS });
  const database = createDatabase({ url: stores.databaseUrl, max: 1, applicationName: 'bundle-seed' });
  try {
    const cfg = queueKeys.cfg(r.eventId);
    await queue.command(['HSET', cfg, ...scheduleFields(r)], { key: cfg });
    await queue.command(['PEXPIREAT', cfg, String(r.startsAtMs)], { key: cfg });
    await queue.command(['ZADD', queueKeys.events, 'GT', String(r.startsAtMs), r.eventId], { key: queueKeys.events });
    const store = new RedisSeatStore(seat, { warn: () => undefined } as never);
    const opened = await store.openSale({ eventId: r.eventId, seatCount: r.seatCount, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
    await new DrizzleSeatRebuildSource(database).markOpened(r.eventId);
    return { eventId: r.eventId, saleEndsAtMs, seatEpoch: opened.seatEpoch, created: opened.created };
  } finally {
    await Promise.allSettled([queue.close(), seat.close(), database.close()]);
  }
}
