// 홀드 원장 seat_hold 쓰기(DrizzleSeatHoldLedger)의 통합 시험: 실제 PostgreSQL 18 컨테이너 하나를 파일 전체가 나눠 쓴다(BUILD_ORDER PRF-141).
// 규칙의 정본은 docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현'의 '적재 소비자', 저장소 요점은 docs/data.md §4 '홀드 원장 적재와 Stream 릴레이',
// 경합 행은 docs/data.md §5 '홀드 원장 적재', 시험 행은 seat-hold.md §12의 S-T5(옛 토큰 무시)·S-T35(held_at = HELD의 occurredAt)다.
//
// 약속:
// - 시험마다 새 회차 ID(이번 달 UUIDv7이라 ensureSeatHoldPartitions가 만든 파티션에 들어간다)를 써서 서로 영향이 없다. 표를 비우지 않는다.
// - DB 상태는 저장소를 거치지 않고 admin 풀의 직접 SQL로 읽어 단언한다.
// - 같은 좌석의 사건은 키 단위 소비자(ADR-0142)가 받은 차례로 하나씩 넘기므로, 같은 좌석 사건은 차례대로만 넣는다(동시에 넣는 것은 시험하지 않는다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, fakeClock, isTransientError, systemClock, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleSeatHoldLedger, HOLD_TTL_MS, type LedgerHoldEvent, type SeatHoldLedger } from '../src/modules/inventory/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { uuid8 } from './seat-stream.js';

let server: PostgresContainer;
/** 저장소에 넘기는 풀(동시 시험이 20건을 한꺼번에 넣으므로 연결 25개, 대기 1초) */
let database: Database;
let ledger: SeatHoldLedger;
/** 읽기용 풀(저장소의 연결을 뺏지 않게 따로) */
let admin: Database;

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  await ensureSeatHoldPartitions(server.url);
  database = createDatabase({ url: server.url, profile: 'general', max: 25, applicationName: 'seat-hold-ledger-it' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'seat-hold-ledger-admin' });
  ledger = new DrizzleSeatHoldLedger(database);
});

afterAll(async () => {
  await Promise.allSettled([database?.close(), admin?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

/** 이번 달 회차 ID(UUIDv7, 파티션 키) */
const newEventId = () => uuidv7(systemClock);
/** 펜싱 토큰(홀드 Lua의 토큰처럼 16자리, 안전한 정수) */
const T1 = 1_762_250_000_000_001;
const T2 = 1_762_250_000_000_002;
const T3 = 1_762_250_000_000_003;
/** 시험 시각의 기준(사건 시각은 파티션과 상관없다) */
const t0 = Date.parse('2026-11-04T10:00:00.000Z');

/** 홀드 하나(같은 좌석·같은 토큰의 사건이 공유하는 값) */
interface Hold {
  eventId: string;
  seatId: string;
  accountId: string;
  token: number;
  heldAtMs: number;
  expiresAtMs: number;
  holdKind: 'FAN' | 'PRIORITY';
  priorityGrantId?: string;
}

const hold = (o: Partial<Hold> & Pick<Hold, 'eventId' | 'seatId' | 'token'>): Hold => {
  const heldAtMs = o.heldAtMs ?? t0;
  return { accountId: randomUUID(), heldAtMs, expiresAtMs: heldAtMs + HOLD_TTL_MS, holdKind: 'FAN', ...o };
};

/** 같은 사건은 같은 eventKey(다시 받은 사건 흉내에 쓴다) */
const keyOf = (type: string, h: Hold) => uuid8(`ledger-it:${type}:${h.eventId}:${h.seatId}:${h.token}`);

const heldEvent = (h: Hold): LedgerHoldEvent => ({
  eventId: h.eventId,
  seatId: h.seatId,
  accountId: h.accountId,
  type: 'HELD',
  fencingToken: h.token,
  holdKind: h.holdKind,
  ...(h.priorityGrantId === undefined ? {} : { priorityGrantId: h.priorityGrantId }),
  occurredAtMs: h.heldAtMs,
  expiresAtMs: h.expiresAtMs,
  eventKey: keyOf('HELD', h),
});

/** 끝 사건(RELEASED·EXPIRED): 같은 홀드의 토큰·계정·만료 시각, 시각은 푼 때 */
const endEvent = (h: Hold, type: 'RELEASED' | 'EXPIRED', atMs: number): LedgerHoldEvent => ({ ...heldEvent(h), type, occurredAtMs: atMs, eventKey: keyOf(type, h) });

interface Row {
  accountId: string;
  fencingToken: number;
  status: string;
  kind: string;
  priorityGrantId: string | null;
  heldAtMs: number | null;
  expiresAtMs: number;
}

/** 그 좌석의 원장 행(토큰 순). 저장소를 거치지 않는 직접 SQL */
async function rows(eventId: string, seatId: string): Promise<Row[]> {
  const r = await admin.pool.query(
    `select account_id, fencing_token::text as fencing_token, status, kind, priority_grant_id, held_at, expires_at
       from seat_hold where event_id = $1 and seat_id = $2 order by fencing_token`,
    [eventId, seatId],
  );
  return r.rows.map((x: Record<string, unknown>) => ({
    accountId: String(x.account_id),
    fencingToken: Number(x.fencing_token),
    status: String(x.status),
    kind: String(x.kind),
    priorityGrantId: x.priority_grant_id === null ? null : String(x.priority_grant_id),
    heldAtMs: x.held_at === null ? null : (x.held_at as Date).getTime(),
    expiresAtMs: (x.expires_at as Date).getTime(),
  }));
}

/** 홀드의 기대 행 */
const rowOf = (h: Hold, status: string, heldAtMs: number | null = h.heldAtMs): Row => ({
  accountId: h.accountId,
  fencingToken: h.token,
  status,
  kind: h.holdKind,
  priorityGrantId: h.priorityGrantId ?? null,
  heldAtMs,
  expiresAtMs: h.expiresAtMs,
});

async function heldCount(eventId: string, seatId: string): Promise<number> {
  const r = await admin.pool.query(`select count(*)::int as n from seat_hold where event_id = $1 and seat_id = $2 and status = 'HELD'`, [eventId, seatId]);
  return Number(r.rows[0].n);
}

// ───────────────────────────── 시험 ─────────────────────────────

describe('DrizzleSeatHoldLedger: HELD 하나와 다시 받기', () => {
  test('ST35_HELD 하나는 HELD 행 하나다: 계정·토큰·kind FAN·priority_grant_id 없음·held_at = HELD의 occurredAt·expires_at = expiresAt', async () => {
    const h = hold({ eventId: newEventId(), seatId: randomUUID(), token: T1 });
    await ledger.apply(heldEvent(h));
    expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, 'HELD', h.heldAtMs)]);
  });

  test('ST35_우선 구매 보류(holdKind PRIORITY)는 kind PRIORITY와 priority_grant_id를 적는다', async () => {
    const h = hold({ eventId: newEventId(), seatId: randomUUID(), token: T1, holdKind: 'PRIORITY', priorityGrantId: randomUUID() });
    await ledger.apply(heldEvent(h));
    expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, 'HELD')]);
  });

  test('같은 HELD를 두 번 받으면 행은 하나 그대로다(기본 키 (event_id, seat_id, fencing_token) 멱등). 이미 채운 held_at은 바꾸지 않는다', async () => {
    const h = hold({ eventId: newEventId(), seatId: randomUUID(), token: T1 });
    await ledger.apply(heldEvent(h));
    await ledger.apply(heldEvent(h));
    expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, 'HELD')]);
    // 같은 키의 행이 있으면 '비어 있는 held_at만' 채운다: 시각이 다른 같은 키 HELD도 held_at을 덮지 않는다
    await ledger.apply({ ...heldEvent(h), occurredAtMs: h.heldAtMs + 5 });
    expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, 'HELD')]);
  });
});

describe('DrizzleSeatHoldLedger: 끝 사건(RELEASED·EXPIRED)', () => {
  test.each(['EXPIRED', 'RELEASED'] as const)('HELD(T1) 뒤 %s(T1)이면 그 행이 그 상태가 되고 held_at·계정·만료 시각은 그대로다', async (type) => {
    const h = hold({ eventId: newEventId(), seatId: randomUUID(), token: T1 });
    await ledger.apply(heldEvent(h));
    await ledger.apply(endEvent(h, type, h.heldAtMs + 60_000));
    expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, type)]);
    // 끝 사건을 다시 받아도 그대로
    await ledger.apply(endEvent(h, type, h.heldAtMs + 60_000));
    expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, type)]);
  });

  test.each(['EXPIRED', 'RELEASED'] as const)(
    'ST5_끝 사건 %s(T1)가 HELD보다 먼저 오면 그 상태로 넣고 held_at은 비운다. 뒤에 온 HELD(T1)는 held_at만 채우고 상태는 끝 상태 그대로다',
    async (type) => {
      const h = hold({ eventId: newEventId(), seatId: randomUUID(), token: T1 });
      await ledger.apply(endEvent(h, type, h.heldAtMs + 60_000));
      expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, type, null)]);
      await ledger.apply(heldEvent(h));
      expect(await rows(h.eventId, h.seatId)).toEqual([rowOf(h, type, h.heldAtMs)]);
      expect(await heldCount(h.eventId, h.seatId)).toBe(0);
    },
  );
});

describe('DrizzleSeatHoldLedger: 같은 좌석의 새 홀드와 옛 토큰(S-T5)', () => {
  test.each([
    { name: 'T1의 expires_at = T2의 held_at(이하)', gapMs: 0, t1: 'EXPIRED' },
    { name: 'T1의 expires_at > T2의 held_at(1ms 늦음)', gapMs: -1, t1: 'RELEASED' },
  ])('ST5_HELD(T1) 뒤 같은 좌석 HELD(T2), T1의 끝 사건은 아직 안 옴 [$name] → T1은 $t1 상태, T2는 HELD이고 HELD 행은 하나다(부분 유일 인덱스와 부딪히지 않는다)', async ({ gapMs, t1 }) => {
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.expiresAtMs + gapMs });
    await ledger.apply(heldEvent(h1));
    await ledger.apply(heldEvent(h2));
    expect(await rows(eventId, seatId)).toEqual([rowOf(h1, t1), rowOf(h2, 'HELD')]);
    expect(await heldCount(eventId, seatId)).toBe(1);
  });

  test('ST5_새 HELD(T2)가 끝 상태로 바꾼 T1 행을, 늦게 온 T1의 진짜 끝 사건(RELEASED)이 바른 상태로 고친다. T2 행은 그대로다', async () => {
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.expiresAtMs });
    await ledger.apply(heldEvent(h1));
    await ledger.apply(heldEvent(h2));
    expect((await rows(eventId, seatId))[0]!.status).toBe('EXPIRED');
    await ledger.apply(endEvent(h1, 'RELEASED', h1.heldAtMs + 120_000));
    expect(await rows(eventId, seatId)).toEqual([rowOf(h1, 'RELEASED'), rowOf(h2, 'HELD')]);
  });

  test('ST5_HELD 셋이 차례로 오면(T1 → T2 → T3) 앞의 둘은 끝 상태이고 HELD는 T3 하나다', async () => {
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.expiresAtMs });
    const h3 = hold({ eventId, seatId, token: T3, heldAtMs: h2.heldAtMs + 1_000 });
    for (const h of [h1, h2, h3]) await ledger.apply(heldEvent(h));
    expect(await rows(eventId, seatId)).toEqual([rowOf(h1, 'EXPIRED'), rowOf(h2, 'RELEASED'), rowOf(h3, 'HELD')]);
    expect(await heldCount(eventId, seatId)).toBe(1);
  });

  test.each([
    { name: 'T1의 expires_at = T2의 held_at', gapMs: 0, t1: 'EXPIRED' },
    { name: 'T1의 expires_at > T2의 held_at', gapMs: -1, t1: 'RELEASED' },
  ])('ST5_늦게 온 옛 HELD(T1 < 이미 있는 T2) [$name] → T1은 $t1 상태로 들어가고(held_at은 T1의 occurredAt) T2는 HELD 그대로다', async ({ gapMs, t1 }) => {
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.expiresAtMs + gapMs });
    await ledger.apply(heldEvent(h2));
    await ledger.apply(heldEvent(h1));
    expect(await rows(eventId, seatId)).toEqual([rowOf(h1, t1), rowOf(h2, 'HELD')]);
    expect(await heldCount(eventId, seatId)).toBe(1);
  });

  test('ST5_옛 토큰의 끝 사건(EXPIRED T1)은 새 홀드 T2 행을 바꾸지 않는다: T1 행이 있을 때는 그 행만, 없을 때는 T1 행을 끝 상태로 새로 넣는다', async () => {
    // T1 행이 있을 때
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.heldAtMs + 60_000 });
    await ledger.apply(heldEvent(h1));
    await ledger.apply(heldEvent(h2));
    await ledger.apply(endEvent(h1, 'EXPIRED', h1.expiresAtMs));
    expect(await rows(eventId, seatId)).toEqual([rowOf(h1, 'EXPIRED'), rowOf(h2, 'HELD')]);

    // T1 행이 없을 때(T1의 HELD가 아직 안 옴)
    const seat2 = randomUUID();
    const g1 = hold({ eventId, seatId: seat2, token: T1 });
    const g2 = hold({ eventId, seatId: seat2, token: T2, heldAtMs: g1.expiresAtMs });
    await ledger.apply(heldEvent(g2));
    await ledger.apply(endEvent(g1, 'EXPIRED', g1.expiresAtMs));
    expect(await rows(eventId, seat2)).toEqual([rowOf(g1, 'EXPIRED', null), rowOf(g2, 'HELD')]);
  });
});

describe('DrizzleSeatHoldLedger: 실패와 동시성', () => {
  test('파티션이 없는 먼 미래 달의 회차는 apply가 던진다: 같은 결과일 실패(isTransientError가 거짓)라 소비자가 5회 뒤 보류하고, 행은 남지 않는다(같은 모양의 이번 달 회차는 들어간다)', async () => {
    // 대조: 같은 모양의 이번 달 회차 사건은 들어간다(던지는 까닭이 회차의 달뿐임을 본다)
    const near = hold({ eventId: newEventId(), seatId: randomUUID(), token: T1 });
    await ledger.apply(heldEvent(near));
    expect(await rows(near.eventId, near.seatId)).toEqual([rowOf(near, 'HELD')]);

    const farEventId = uuidv7(fakeClock({ now: Date.parse('2031-03-15T03:00:00.000Z') }));
    const h = { ...near, eventId: farEventId };
    for (let i = 0; i < 2; i++) {
      const err = await ledger.apply(heldEvent(h)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(isTransientError(err)).toBe(false);
    }
    const n = await admin.pool.query('select count(*)::int as n from seat_hold where event_id = $1', [farEventId]);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  test('서로 다른 좌석 20개의 HELD를 한꺼번에 넣어도 모두 HELD 행으로 들어간다(사건마다 트랜잭션 하나)', async () => {
    const eventId = newEventId();
    const holds = Array.from({ length: 20 }, (_, i) => hold({ eventId, seatId: randomUUID(), token: T1 + i, heldAtMs: t0 + i }));
    // 풀 대기(1초)에 걸리지 않게 연결을 미리 맺어 둔다
    const clients = await Promise.all(Array.from({ length: 20 }, () => database.pool.connect()));
    for (const c of clients) c.release();
    const results = await Promise.allSettled(holds.map((h) => ledger.apply(heldEvent(h))));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const h of holds) expect(await rows(eventId, h.seatId)).toEqual([rowOf(h, 'HELD')]);
    const n = await admin.pool.query(`select count(*)::int as n from seat_hold where event_id = $1 and status = 'HELD'`, [eventId]);
    expect(Number(n.rows[0].n)).toBe(20);
  });
});

describe('시험 검토 B가 더한 차례 보정 사례', () => {
  test('ST5_끝 사건으로 이미 RELEASED인 T1 행은 뒤에 온 HELD(T2)가 다시 바꾸지 않는다(HELD 행만 끝 상태로 바꾼다) [S-T5]', async () => {
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    // T2의 held_at이 T1의 만료와 같아 'HELD 행 고치기' 규칙이면 EXPIRED가 될 자리다. 이미 RELEASED라 그대로여야 한다
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.expiresAtMs });
    await ledger.apply(heldEvent(h1));
    await ledger.apply(endEvent(h1, 'RELEASED', h1.heldAtMs + 30_000));
    await ledger.apply(heldEvent(h2));

    expect(await rows(eventId, seatId)).toEqual([rowOf(h1, 'RELEASED'), rowOf(h2, 'HELD')]);
  });

  test('ST5_늦게 온 옛 HELD(T1)는 바로 뒤 홀드(T2)의 held_at과 견준다(가장 높은 토큰 T3이 아니라) [S-T5]', async () => {
    const eventId = newEventId();
    const seatId = randomUUID();
    const h1 = hold({ eventId, seatId, token: T1 });
    // T2는 T1의 만료 1ms 전에 잡혔다(T1은 풀린 것 = RELEASED). T3과 견주면 EXPIRED로 틀린다
    const h2 = hold({ eventId, seatId, token: T2, heldAtMs: h1.expiresAtMs - 1 });
    const h3 = hold({ eventId, seatId, token: T3, heldAtMs: h1.expiresAtMs + 60_000 });
    await ledger.apply(heldEvent(h2));
    await ledger.apply(heldEvent(h3));
    await ledger.apply(heldEvent(h1));

    const got = await rows(eventId, seatId);
    expect(got[0]).toEqual(rowOf(h1, 'RELEASED'));
    expect(got[2]).toEqual(rowOf(h3, 'HELD'));
  });
});
