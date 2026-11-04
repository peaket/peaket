// 다시 만들기의 purchase DB 쪽 DrizzleSeatRebuildSource의 통합 시험: 실제 PostgreSQL 18 컨테이너 하나를 파일 전체가 나눠 쓴다(BUILD_ORDER PRF-143).
// 규칙의 정본은 docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현'의 '회차마다 하나와 판 번호'·'읽기', 저장소 요점은 docs/data.md §4 '다시 만들기 표와 원장 칸',
// 경합 행은 docs/data.md §5 '다시 만들기', 명세는 specs/seat.qnt의 rebuild, 시험 행은 seat-hold.md §12의 S-T26이다.
//
// 약속:
// - 시험마다 새 회차 ID를 써서 서로 영향이 없다. 표를 비우지 않는다(seat_hold는 이번 달 UUIDv7 회차라 ensureSeatHoldPartitions가 만든 파티션에 들어간다).
// - DB 상태는 소스를 거치지 않고 admin 풀의 직접 SQL로 읽어 단언한다. 시각 견주기는 DB 시계 하나로 한다(컨테이너와 이 PC의 시계가 다를 수 있다).
// - '두 파드'는 연결 풀이 다른 소스 둘이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDatabase, type Database, systemClock, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleSeatRebuildSource, REBUILD_LEASE_MS, type RebuildHold, type RebuildSale } from '../src/modules/inventory/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let server: PostgresContainer;
/** 파드 A·B의 풀(따로 둬서 두 파드가 같은 연결을 나눠 쓰지 않게) */
let dbA: Database;
let dbB: Database;
/** 읽기·씨앗 넣기용 풀 */
let admin: Database;
let podA: DrizzleSeatRebuildSource;
let podB: DrizzleSeatRebuildSource;

const APP_A = 'rebuild-src-a';

beforeAll(async () => {
  server = await startPostgres();
  await migratePurchase(server.url);
  await ensureSeatHoldPartitions(server.url);
  dbA = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: APP_A });
  dbB = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'rebuild-src-b' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'rebuild-src-admin' });
  podA = new DrizzleSeatRebuildSource(dbA);
  podB = new DrizzleSeatRebuildSource(dbB);
});

afterAll(async () => {
  await Promise.allSettled([dbA?.close(), dbB?.close(), admin?.close()]);
  server?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = (text: string, params: unknown[] = []) => admin.pool.query(text, params);

interface RebuildRow {
  gen: number;
  holder: string | null;
  leaseUntilMs: number | null;
}

/** 그 회차의 seat_rebuild 행(없으면 null) */
async function rebuildRow(eventId: string): Promise<RebuildRow | null> {
  const r = await q('select gen, holder, lease_until from seat_rebuild where event_id = $1', [eventId]);
  if (r.rows.length === 0) return null;
  const x = r.rows[0] as { gen: number; holder: string | null; lease_until: Date | null };
  return { gen: Number(x.gen), holder: x.holder, leaseUntilMs: x.lease_until === null ? null : x.lease_until.getTime() };
}

/** DB 시계의 지금(ms) */
async function dbNow(): Promise<number> {
  const r = await q('select clock_timestamp() as t');
  return (r.rows[0].t as Date).getTime();
}

/** 소스 풀의 연결 n개를 미리 맺어 둔다(동시 시험에서 연결 맺기가 한쪽만 늦추지 않게) */
async function warm(db: Database, n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => db.pool.connect()));
  for (const c of clients) c.release();
}

const putSale = (eventId: string, seatId: string, accountId: string, orderId: string, status: 'PENDING' | 'SOLD' | 'RETURNED') =>
  q('insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, $5)', [eventId, seatId, orderId, accountId, status]);

interface HoldSeed {
  seatId: string;
  accountId: string;
  token: number;
  status: 'HELD' | 'RELEASED' | 'EXPIRED';
  kind: 'FAN' | 'PRIORITY';
  heldAtMs: number | null;
  expiresAtMs: number;
  holdId: string | null;
  purchaseSessionId: string | null;
}

/** 원장 행 하나를 직접 SQL로 넣는다(적재 소비자를 거치지 않는다) */
const putHold = (eventId: string, h: HoldSeed) =>
  q(
    `insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, held_at, expires_at, hold_id, purchase_session_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      eventId,
      h.seatId,
      h.accountId,
      h.token,
      h.status,
      h.kind,
      h.heldAtMs === null ? null : new Date(h.heldAtMs),
      new Date(h.expiresAtMs),
      h.holdId,
      h.purchaseSessionId,
    ],
  );

const T1 = 1_762_250_000_000_001;
const MIN = 60_000;

const bySeat = <T extends { seatId: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0));

// ───────────────────────────── 시험 ─────────────────────────────

describe('acquire: 임대를 잡으며 판 번호를 올린다(한 문장, 바로 커밋)', () => {
  test('ST26_행이 없으면 판 번호 2로 넣고 2를 돌려준다: holder = 부른 파드, lease_until = 그 문장의 now() + 60초(REBUILD_LEASE_MS) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await rebuildRow(e)).toBeNull();
    const before = await dbNow();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    const after = await dbNow();
    const row = await rebuildRow(e);
    expect(row).toMatchObject({ gen: 2, holder: 'pod-a' });
    // 문장의 now()는 before와 after 사이다(시험 PC 시계가 아니라 DB 시계)
    expect(REBUILD_LEASE_MS).toBe(60_000);
    expect(row!.leaseUntilMs).toBeGreaterThanOrEqual(before + REBUILD_LEASE_MS);
    expect(row!.leaseUntilMs).toBeLessThanOrEqual(after + REBUILD_LEASE_MS);
  });

  test('ST26_acquire가 끝나면 이미 커밋되어 있다: 다른 연결이 새 판 번호를 보고, 소스 풀에 열린 트랜잭션(idle in transaction)이 없다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    const gen = await podA.acquire(e, 'pod-a');
    expect(gen).toBe(2);
    expect((await rebuildRow(e))?.gen).toBe(gen);
    const r = await q(`select count(*)::int as n from pg_stat_activity where application_name = $1 and state like 'idle in transaction%'`, [APP_A]);
    expect(Number(r.rows[0].n)).toBe(0);
  });

  test('ST26_임대 중이면 다른 holder의 acquire는 null이고 행(판 번호·holder·lease_until)은 그대로다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    const row = await rebuildRow(e);
    expect(await podB.acquire(e, 'pod-b')).toBeNull();
    expect(await rebuildRow(e)).toEqual(row);
  });

  test('ST26_임대 중이면 같은 holder가 다시 불러도 null이다(임대를 늘리거나 판 번호를 올리지 않는다) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    const row = await rebuildRow(e);
    expect(await podA.acquire(e, 'pod-a')).toBeNull();
    expect(await rebuildRow(e)).toEqual(row);
  });

  test('ST26_release 뒤 다시 acquire하면 판 번호 3이다(release는 임대만 비우고 판 번호는 그대로) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    await podA.release(e, 'pod-a');
    const released = await rebuildRow(e);
    expect(released).toMatchObject({ gen: 2, leaseUntilMs: null });
    expect(await podB.acquire(e, 'pod-b')).toBe(3);
    expect(await rebuildRow(e)).toMatchObject({ gen: 3, holder: 'pod-b' });
    await podB.release(e, 'pod-b');
    expect(await podA.acquire(e, 'pod-a')).toBe(4);
  });

  test('ST26_임대가 지나면(lease_until을 SQL로 과거로) 다른 holder가 잡고 판 번호가 1 오른다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    // pod-a가 멈춰 임대를 비우지 못한 채 60초가 지난 것
    await q(`update seat_rebuild set lease_until = now() - interval '1 second' where event_id = $1`, [e]);
    expect(await podB.acquire(e, 'pod-b')).toBe(3);
    const row = await rebuildRow(e);
    expect(row).toMatchObject({ gen: 3, holder: 'pod-b' });
    expect(row!.leaseUntilMs).toBeGreaterThan(await dbNow());
  });

  test('ST26_짧은 임대(leaseMs 300)로 만든 소스: lease_until = now() + 300ms이고, DB 시계가 그 시각을 지난 뒤 다른 holder가 잡는다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const short = new DrizzleSeatRebuildSource(dbA, 300);
    const e = randomUUID();
    const before = await dbNow();
    expect(await short.acquire(e, 'pod-a')).toBe(2);
    const after = await dbNow();
    const row = await rebuildRow(e);
    expect(row!.leaseUntilMs).toBeGreaterThanOrEqual(before + 300);
    expect(row!.leaseUntilMs).toBeLessThanOrEqual(after + 300);
    // DB 시계가 lease_until을 지날 때까지 기다린다(고정 sleep이 아니라 DB 시계로 확인)
    for (let i = 0; i < 100 && (await dbNow()) <= row!.leaseUntilMs!; i++) await sleep(20);
    expect(await dbNow()).toBeGreaterThan(row!.leaseUntilMs!);
    expect(await podB.acquire(e, 'pod-b')).toBe(3);
    expect((await rebuildRow(e))?.holder).toBe('pod-b');
  });
});

describe('release: 그 holder일 때만 임대를 비운다', () => {
  test('ST26_다른 holder의 release는 아무것도 바꾸지 않아 임대가 남고, 제3의 파드도 못 잡는다. 임자의 release 뒤에는 잡는다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    const row = await rebuildRow(e);
    await podB.release(e, 'pod-b');
    expect(await rebuildRow(e)).toEqual(row);
    expect(await podB.acquire(e, 'pod-c')).toBeNull();
    await podA.release(e, 'pod-a');
    expect((await rebuildRow(e))?.leaseUntilMs).toBeNull();
    expect(await podB.acquire(e, 'pod-c')).toBe(3);
  });

  test('ST26_임대가 지나 다른 파드가 이어 받은 뒤, 늦게 끝난 옛 파드의 release는 새 임대를 비우지 않는다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = randomUUID();
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    await q(`update seat_rebuild set lease_until = now() - interval '1 second' where event_id = $1`, [e]);
    expect(await podB.acquire(e, 'pod-b')).toBe(3);
    const row = await rebuildRow(e);
    await podA.release(e, 'pod-a');
    expect(await rebuildRow(e)).toEqual(row);
  });

  test('행이 없는 회차의 release는 행을 만들지 않고 던지지 않는다', async () => {
    const e = randomUUID();
    await podA.release(e, 'pod-a');
    expect(await rebuildRow(e)).toBeNull();
  });
});

describe('acquire 동시성: 두 파드가 한꺼번에 잡으면 하나만 판 번호를 받는다', () => {
  test('ST26_20라운드: 행이 없을 때와 비운 뒤 두 번 모두, 두 파드가 동시에 acquire하면 정확히 하나만 판 번호(2, 그다음 3)를 받고 행의 holder는 그 파드다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    await Promise.all([warm(dbA, 2), warm(dbB, 2)]);
    for (let round = 0; round < 20; round++) {
      const e = randomUUID();
      const first = await Promise.all([podA.acquire(e, 'pod-a'), podB.acquire(e, 'pod-b')]);
      expect(first.filter((g) => g !== null), `라운드 ${round} 처음`).toEqual([2]);
      const winner = first[0] !== null ? 'pod-a' : 'pod-b';
      expect(await rebuildRow(e)).toMatchObject({ gen: 2, holder: winner });
      await (winner === 'pod-a' ? podA : podB).release(e, winner);
      const second = await Promise.all([podB.acquire(e, 'pod-b'), podA.acquire(e, 'pod-a')]);
      expect(second.filter((g) => g !== null), `라운드 ${round} 비운 뒤`).toEqual([3]);
      expect(await rebuildRow(e)).toMatchObject({ gen: 3, holder: second[0] !== null ? 'pod-b' : 'pod-a' });
    }
  });
});

describe('sales: 회차의 활성 판매(PENDING·SOLD)', () => {
  test('ST26_PENDING·SOLD만 좌석·계정·주문으로 준다: RETURNED와 다른 회차의 판매는 빠진다. 환불 뒤 재판매한 좌석은 새 활성 행만 [S-T26]', async () => {
    const e = randomUUID();
    const other = randomUUID();
    const [s1, s2, s3, s4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [a1, a2, a3] = [randomUUID(), randomUUID(), randomUUID()];
    const [o1, o2, o3, o4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await putSale(e, s1, a1, o1, 'PENDING');
    await putSale(e, s2, a2, o2, 'SOLD');
    await putSale(e, s3, a3, o3, 'RETURNED');
    // s4: 환불(RETURNED) 뒤 다른 계정이 다시 샀다
    await putSale(e, s4, a1, o3, 'RETURNED');
    await putSale(e, s4, a3, o4, 'SOLD');
    // 다른 회차의 같은 좌석 ID
    await putSale(other, s3, a2, randomUUID(), 'SOLD');

    const expected: RebuildSale[] = [
      { seatId: s1, accountId: a1, orderId: o1 },
      { seatId: s2, accountId: a2, orderId: o2 },
      { seatId: s4, accountId: a3, orderId: o4 },
    ];
    expect(bySeat(await podA.sales(e))).toEqual(bySeat(expected));
  });

  test('ST26_판매가 없는 회차는 빈 배열이다 [S-T26]', async () => {
    expect(await podA.sales(randomUUID())).toEqual([]);
  });
});

describe('holds: 회차의 만료 전 원장 홀드(HELD, expires_at > now())', () => {
  test('ST26_HELD이고 만료 전인 행만 준다: RELEASED·EXPIRED·만료된 HELD·다른 회차는 빠진다. 칸은 좌석·계정·토큰·종류·잡은 시각(null 가능)·만료 시각·holdId·구매 세션 ID [S-T26]', async () => {
    const e = uuidv7(systemClock);
    const other = uuidv7(systemClock);
    const now = Date.now();
    const base = { status: 'HELD' as const, kind: 'FAN' as const };
    const live: HoldSeed = { ...base, seatId: randomUUID(), accountId: randomUUID(), token: T1, heldAtMs: now - MIN, expiresAtMs: now + 5 * MIN, holdId: randomUUID(), purchaseSessionId: randomUUID() };
    // 우선 구매 보류, 잡은 시각이 빈 행, holdId·구매 세션이 빈 옛 행(소스는 그대로 주고 되살리기 여부는 planRebuild가 가른다)
    const oldRow: HoldSeed = { ...base, seatId: randomUUID(), accountId: randomUUID(), token: T1 + 1, kind: 'PRIORITY', heldAtMs: null, expiresAtMs: now + 6 * MIN, holdId: null, purchaseSessionId: null };
    const out: HoldSeed[] = [
      { ...live, seatId: randomUUID(), status: 'RELEASED', holdId: randomUUID() },
      { ...live, seatId: randomUUID(), status: 'EXPIRED', holdId: randomUUID() },
      // 만료된 HELD(만료 Lua가 풀었는데 끝 사건이 아직 안 온 것)
      { ...live, seatId: randomUUID(), expiresAtMs: now - 10 * MIN, heldAtMs: now - 17 * MIN, holdId: randomUUID() },
    ];
    for (const h of [live, oldRow, ...out]) await putHold(e, h);
    await putHold(other, { ...live, seatId: randomUUID() });

    const expected: RebuildHold[] = [live, oldRow].map((h) => ({
      seatId: h.seatId,
      accountId: h.accountId,
      fencingToken: h.token,
      kind: h.kind,
      heldAtMs: h.heldAtMs,
      expiresAtMs: h.expiresAtMs,
      holdId: h.holdId,
      purchaseSessionId: h.purchaseSessionId,
    }));
    const got = await podA.holds(e);
    expect(bySeat(got)).toEqual(bySeat(expected));
    // 토큰은 16자리 안전한 정수 그대로(글이나 bigint가 아니다)
    for (const h of got) expect(Number.isSafeInteger(h.fencingToken)).toBe(true);
  });

  test('ST26_같은 좌석에 끝난 옛 홀드와 지금 HELD가 함께 있으면 HELD 하나만 준다 [S-T26]', async () => {
    const e = uuidv7(systemClock);
    const now = Date.now();
    const seatId = randomUUID();
    const accountId = randomUUID();
    const old: HoldSeed = { seatId, accountId, token: T1, status: 'EXPIRED', kind: 'FAN', heldAtMs: now - 8 * MIN, expiresAtMs: now + MIN, holdId: randomUUID(), purchaseSessionId: randomUUID() };
    const cur: HoldSeed = { ...old, token: T1 + 5, status: 'HELD', heldAtMs: now - MIN, expiresAtMs: now + 6 * MIN, holdId: randomUUID() };
    await putHold(e, old);
    await putHold(e, cur);
    expect(await podA.holds(e)).toEqual([
      { seatId, accountId, fencingToken: cur.token, kind: 'FAN', heldAtMs: cur.heldAtMs, expiresAtMs: cur.expiresAtMs, holdId: cur.holdId, purchaseSessionId: cur.purchaseSessionId },
    ]);
  });

  test('ST26_원장 홀드가 없는 회차는 빈 배열이다 [S-T26]', async () => {
    expect(await podA.holds(uuidv7(systemClock))).toEqual([]);
  });
});

describe('코드 리뷰 재현(PRF-143)', () => {
  test('ST26_코드 리뷰_ saleHolds: 활성 판매(PENDING·SOLD)가 있는 좌석·그 판매 계정의 HELD 원장 행을 만료 시각과 관계없이 준다. 남의 계정·끝난 판매·RELEASED·판매 없는 좌석은 빠진다 [S-T26]', async () => {
    const e = uuidv7(systemClock);
    const now = Date.now();
    const [A, B] = [randomUUID(), randomUUID()];
    const [s1, s2, s3, s4, s5] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await putSale(e, s1, A, randomUUID(), 'PENDING');
    await putSale(e, s2, A, randomUUID(), 'SOLD');
    await putSale(e, s3, A, randomUUID(), 'RETURNED');
    await putSale(e, s5, A, randomUUID(), 'SOLD');
    const base = { status: 'HELD' as const, kind: 'FAN' as const, holdId: randomUUID(), purchaseSessionId: randomUUID() };
    // s1: 묶인 지 10분이라 만료 시각이 지난 HELD(나와야 한다)
    const pinned: HoldSeed = { ...base, seatId: s1, accountId: A, token: T1, heldAtMs: now - 10 * MIN, expiresAtMs: now - 3 * MIN };
    // s2: 만료 전 HELD(나와야 한다)와 같은 좌석의 RELEASED(빠진다). s5: A가 산 좌석의 남의 계정(B) HELD(빠진다, 좌석마다 HELD는 하나)
    const live: HoldSeed = { ...base, seatId: s2, accountId: A, token: T1 + 2, heldAtMs: null, expiresAtMs: now + 5 * MIN, holdId: randomUUID() };
    await putHold(e, pinned);
    await putHold(e, live);
    await putHold(e, { ...live, token: T1 + 1, status: 'RELEASED', holdId: randomUUID() });
    await putHold(e, { ...live, seatId: s5, accountId: B, token: T1 + 3, holdId: randomUUID() });
    // s3: 끝난 판매(RETURNED)의 HELD, s4: 판매가 없는 좌석의 HELD(빠진다)
    await putHold(e, { ...pinned, seatId: s3, token: T1 + 4, holdId: randomUUID() });
    await putHold(e, { ...pinned, seatId: s4, token: T1 + 5, holdId: randomUUID() });
    const want: RebuildHold[] = [pinned, live].map((h) => ({
      seatId: h.seatId,
      accountId: h.accountId,
      fencingToken: h.token,
      kind: h.kind,
      heldAtMs: h.heldAtMs,
      expiresAtMs: h.expiresAtMs,
      holdId: h.holdId,
      purchaseSessionId: h.purchaseSessionId,
    }));
    expect(bySeat(await podA.saleHolds(e))).toEqual(bySeat(want));
    // holds()는 지금처럼 만료 전만(묶인 s1의 행은 없다)
    expect((await podA.holds(e)).map((h) => h.seatId)).not.toContain(s1);
    expect(await podA.saleHolds(uuidv7(systemClock))).toEqual([]);
  });

  test('ST26_코드 리뷰_ release의 setGen은 같은 문장에서 판 번호를 그 값으로 맞추고 임대를 비운다(holder가 다르면 아무것도 바꾸지 않는다). 1 이상의 정수가 아니면 RangeError [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = uuidv7(systemClock);
    expect(await podA.acquire(e, 'pod-a')).toBe(2);
    await podB.release(e, 'pod-b', { setGen: 9 });
    expect(await rebuildRow(e)).toMatchObject({ gen: 2, holder: 'pod-a' });
    await podA.release(e, 'pod-a', { setGen: 9 });
    expect(await rebuildRow(e)).toEqual({ gen: 9, holder: null, leaseUntilMs: null });
    expect(await podA.acquire(e, 'pod-a')).toBe(10);
    // 세대 키가 판매 열기의 gen 1이면 1로 맞춘다(다음 다시 만들기는 2)
    await podA.release(e, 'pod-a', { setGen: 1 });
    expect(await rebuildRow(e)).toMatchObject({ gen: 1, holder: null });
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(podA.release(e, 'pod-a', { setGen: bad })).rejects.toBeInstanceOf(RangeError);
  });
});
