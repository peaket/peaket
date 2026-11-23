// 관제 실시간 표 ops-svc 읽기 쪽 통합 시험(OPS-160, F-04-1). 실제 ClickHouse(24.12 컨테이너)에 rt 표·뷰를 이전 실행기(services/ops-rt/src/migrate.ts,
// 한 대짜리 변환)로 만들고, 원시 행과 심장 박동을 넣은 뒤 진짜 ClickHouseRtSource를 단 RtBoard가 0.5초 주기로 읽은 값을 정답과 견준다.
// 단위 시험의 짝 가짜(MemoryRtSource)와 같은 보드·같은 행 모양이 진짜 원천에서도 성립하는지(행동 짝) 보는 자리다.
// 회차 기준 자료(bronze.brz_ref_seat_map)는 F-04-3이 만들 표라 여기서 한 대짜리 MergeTree로 만든다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateRt } from '../../ops-rt/src/migrate.js';
import { AppModule } from '../src/app.module.js';
import { ClickHouseRtSource, PromRtSignals, RtBoard, type EventOwners, type PartitionRef } from '../src/modules/realtime-table/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { startClickHouse, type ClickHouseContainer } from './clickhouse.js';

const RT_DIR = fileURLToPath(new URL('../../../data/clickhouse/rt', import.meta.url));
const E = randomUUID();
const OTHER_E = randomUUID();
const TENANT = randomUUID();
const EXPECTED: readonly PartitionRef[] = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'].flatMap((topic) => [0, 1, 2].map((partition) => ({ topic, partition })));
const STOPPED: PartitionRef = { topic: 'telemetry.purchase', partition: 1 };

/** ClickHouse 서버 시간대(UTC)의 DateTime64 글자 */
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

let ch: ClickHouseContainer;
let board: RtBoard;
let signals: PromRtSignals;
let pulseTimer: ReturnType<typeof setInterval> | undefined;
const stopped = new Set<string>();
let pulsing = false;
let insertedAtMs = 0;
/** 원시 행을 넣은 시각(1초 칸 시각의 기준) */
let baseMs = 0;

const insert = (table: string, rows: readonly Record<string, unknown>[]) =>
  ch.exec(`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((r) => JSON.stringify(r)).join('\n')}`);

let offset = 0;
const sale = (o: { key?: string; source: 'SEAT' | 'ORDER' | 'PAYMENT' | 'TICKET'; type: string; seat?: string; tier?: string; section?: string; amount?: number; first?: boolean; eventId?: string; at?: number; off?: number }) => ({
  event_id: o.eventId ?? E,
  event_key: o.key ?? randomUUID(),
  source: o.source,
  type: o.type,
  seat_id: o.seat ?? '',
  tier_id: o.tier ?? '',
  section_id: o.section ?? '',
  amount: o.amount ?? 0,
  first_in_stage: o.first ?? false,
  occurred_at: chTime(o.at ?? baseMs),
  kafka_partition: 0,
  kafka_offset: o.off ?? (offset += 1),
});

async function pulseOnce(): Promise<void> {
  if (pulsing) return;
  pulsing = true;
  try {
    const at = chTime(Date.now());
    const rows = EXPECTED.filter((p) => !stopped.has(`${p.topic}#${p.partition}`)).map((p) => ({ topic: p.topic, kafka_partition: p.partition, produced_at: at }));
    await insert('rt.pulse', rows);
  } finally {
    pulsing = false;
  }
}

beforeAll(async () => {
  ch = await startClickHouse();
  const statements = await migrateRt((sql) => ch.exec(sql), RT_DIR, 'single');
  expect(statements).toBeGreaterThanOrEqual(9);
  await ch.exec('CREATE DATABASE IF NOT EXISTS bronze');
  await ch.exec(`CREATE TABLE bronze.brz_ref_seat_map (
      event_id String, layout_version UInt32, section_id String, section_name String, tier_id String,
      price Int64, seat_count UInt32, seat_index_from UInt32, seat_index_to UInt32
    ) ENGINE = MergeTree ORDER BY (event_id, layout_version, section_id)`);
  await insert('bronze.brz_ref_seat_map', [
    // 옛 배치 판 1은 세지 않는다
    { event_id: E, layout_version: 1, section_id: 'A', section_name: 'A구역', tier_id: 'R', price: 150_000, seat_count: 100, seat_index_from: 1, seat_index_to: 100 },
    { event_id: E, layout_version: 1, section_id: 'B', section_name: 'B구역', tier_id: 'S', price: 120_000, seat_count: 100, seat_index_from: 1, seat_index_to: 100 },
    { event_id: E, layout_version: 2, section_id: 'A', section_name: 'A구역', tier_id: 'R', price: 150_000, seat_count: 10, seat_index_from: 1, seat_index_to: 10 },
    { event_id: E, layout_version: 2, section_id: 'B', section_name: 'B구역', tier_id: 'S', price: 120_000, seat_count: 15, seat_index_from: 1, seat_index_to: 15 },
    { event_id: E, layout_version: 2, section_id: 'B', section_name: 'B구역', tier_id: 'S', price: 120_000, seat_count: 5, seat_index_from: 16, seat_index_to: 20 },
  ]);
  baseMs = Math.floor(Date.now() / 1_000) * 1_000 - 3_000;
  const k = Object.fromEntries(['s1p', 's1s', 's1p2', 's1s2', 's1r', 's2p', 's2s', 's3s', 'p1', 'o3', 't1', 'q1'].map((n) => [n, randomUUID()]));
  insertedAtMs = Date.now();
  await insert('rt.sale_event', [
    // 좌석 s1: PENDING → SOLD → PENDING(입금 되돌림) → SOLD → RETURNED = 판매 아님
    sale({ key: k.s1p, source: 'SEAT', type: 'PENDING', seat: 's1', tier: 'R', section: 'A', off: 1 }),
    sale({ key: k.s1s, source: 'SEAT', type: 'SOLD', seat: 's1', tier: 'R', section: 'A', off: 2 }),
    sale({ key: k.s1p2, source: 'SEAT', type: 'PENDING', seat: 's1', tier: 'R', section: 'A', off: 3 }),
    sale({ key: k.s1s2, source: 'SEAT', type: 'SOLD', seat: 's1', tier: 'R', section: 'A', off: 4 }),
    sale({ key: k.s1r, source: 'SEAT', type: 'RETURNED', seat: 's1', tier: 'R', section: 'A', off: 5 }),
    // 다시 읽은 행(같은 eventKey, 더 늦은 위치)은 무시된다
    sale({ key: k.s1s2, source: 'SEAT', type: 'SOLD', seat: 's1', tier: 'R', section: 'A', off: 50 }),
    // 좌석 s2: PENDING → SOLD, 다시 보낸 옛 PENDING(같은 eventKey, 늦은 위치)은 무시 → 판매
    sale({ key: k.s2p, source: 'SEAT', type: 'PENDING', seat: 's2', tier: 'R', section: 'A', off: 6 }),
    sale({ key: k.s2s, source: 'SEAT', type: 'SOLD', seat: 's2', tier: 'R', section: 'A', off: 7 }),
    sale({ key: k.s2p, source: 'SEAT', type: 'PENDING', seat: 's2', tier: 'R', section: 'A', off: 52 }),
    // 좌석 s3: SOLD
    sale({ key: k.s3s, source: 'SEAT', type: 'SOLD', seat: 's3', tier: 'S', section: 'B', off: 8 }),
    // 결제: 승인 50,000 + 승인 30,000 − 입금 되돌림 30,000, p1 중복
    sale({ key: k.p1, source: 'PAYMENT', type: 'APPROVED', amount: 50_000 }),
    sale({ key: k.p1, source: 'PAYMENT', type: 'APPROVED', amount: 50_000 }),
    sale({ source: 'PAYMENT', type: 'APPROVED', amount: 30_000 }),
    sale({ source: 'PAYMENT', type: 'DEPOSIT_REVERSED', amount: 30_000 }),
    // 주문: 확정 셋 − 입금 되돌림 하나 = 2, 퍼널은 '처음' 표시만(다시 확정은 세지 않는다), o3 중복
    sale({ source: 'ORDER', type: 'ACCEPTED', first: true }),
    sale({ source: 'ORDER', type: 'APPROVED', first: true }),
    sale({ key: k.o3, source: 'ORDER', type: 'CONFIRMED', first: true }),
    sale({ key: k.o3, source: 'ORDER', type: 'CONFIRMED', first: true }),
    sale({ source: 'ORDER', type: 'CONFIRMED', first: true }),
    sale({ source: 'ORDER', type: 'DEPOSIT_REVERSED' }),
    sale({ source: 'ORDER', type: 'CONFIRMED', first: false }),
    // 티켓: 발권 둘 − 무효 하나, t1 중복
    sale({ key: k.t1, source: 'TICKET', type: 'ISSUED' }),
    sale({ key: k.t1, source: 'TICKET', type: 'ISSUED' }),
    sale({ source: 'TICKET', type: 'ISSUED' }),
    sale({ source: 'TICKET', type: 'VOIDED' }),
    // 다른 회차는 섞이지 않는다
    sale({ eventId: OTHER_E, source: 'SEAT', type: 'SOLD', seat: 's9', tier: 'R', section: 'A', off: 9 }),
  ]);
  // 같은 좌석 사건을 다른 묶음으로 한 번 더(중복 적재)
  await insert('rt.sale_event', [sale({ key: k.s3s, source: 'SEAT', type: 'SOLD', seat: 's3', tier: 'S', section: 'B', off: 8 })]);
  await insert('rt.queue_aggregate', [
    { event_id: E, event_key: k.q1, pod: 'p1', second: chTime(baseMs).slice(0, 19), entries: 100, admissions: 40, removed: 5 },
    { event_id: E, event_key: k.q1, pod: 'p1', second: chTime(baseMs).slice(0, 19), entries: 100, admissions: 40, removed: 5 },
    { event_id: E, event_key: randomUUID(), pod: 'p2', second: chTime(baseMs + 1_000).slice(0, 19), entries: 50, admissions: 10, removed: 5 },
  ]);
  const hold = (result: string, tier: string, first: boolean) => ({ event_id: E, event_key: randomUUID(), result, tier_id: tier, first_held_in_session: first, occurred_at: chTime(baseMs + 1_250) });
  await insert('rt.hold_attempt', [hold('HELD', 'R', true), hold('HELD', 'S', true), hold('HELD', 'R', false), hold('CONFLICT', 'S', false)]);
  await pulseOnce();
  pulseTimer = setInterval(() => void pulseOnce().catch(() => undefined), 500);
  signals = new PromRtSignals();
  board = new RtBoard({
    source: new ClickHouseRtSource({ baseUrl: ch.url, user: ch.user, password: ch.password }),
    seatMaps: new ClickHouseRtSource({ baseUrl: ch.url, user: ch.user, password: ch.password }),
    now: () => Date.now(),
    monotonicMs: () => performance.now(),
    expected: EXPECTED,
    signals,
  });
  board.start();
}, 180_000);

afterAll(async () => {
  if (pulseTimer) clearInterval(pulseTimer);
  await board?.stop();
  ch?.stop();
});

describe('F-04-1 실제 ClickHouse rt 뷰를 읽는 RtBoard', () => {
  test('F-04-1 ST-T10 ② ops-svc 0.5초 주기로 읽은 누적이 정답과 같다(중복 eventKey·PENDING→SOLD→PENDING→SOLD→RETURNED·다시 보낸 옛 사건·결제 승인과 되돌림), 새 판매는 다음 주기에 보인다', async () => {
    // 뷰 셋이 이 판 ClickHouse에서 매개변수와 함께 돈다(실패하면 뷰 SQL의 오류가 그대로 보인다)
    for (const sql of [
      `SELECT count() FROM rt.v_cumulative(event_id = '${E}')`,
      `SELECT count() FROM rt.v_bucket(event_id = '${E}', from_ts = '2000-01-01 00:00:00.000')`,
      'SELECT count() FROM rt.v_freshness',
    ]) {
      await expect(ch.exec(sql), sql).resolves.toMatch(/^\d+\n$/);
    }
    const first = await board.snapshot(E);
    const { lastTradeLoadedMs, ...cumulative } = first.cumulative;
    expect(cumulative).toEqual({
      soldSeats: 2,
      soldSeatsByTier: { R: 1, S: 1 },
      soldSeatsBySection: { A: 1, B: 1 },
      salesAmount: 50_000,
      ordersConfirmed: 2,
      ticketsIssued: 1,
      funnel: { admitted: 50, firstHold: 2, paymentAccepted: 1, approved: 1, issued: 2 },
      firstHoldByTier: { R: 1, S: 1 },
      queue: { entries: 150, admissions: 50, removed: 10, waiting: 90 },
    });
    // 적재 시각은 ClickHouse 서버 시계(now64)라 컨테이너와 이 PC의 시계 차를 5초까지 둔다
    expect(Math.abs(lastTradeLoadedMs - insertedAtMs)).toBeLessThan(5_000);
    // 잔여석은 마지막 배치 판(2) 30석 기준
    expect(first.remaining).toEqual({ total: 28, bySection: { A: 9, B: 19 }, byTier: { R: 9, S: 19 } });
    // 1초 칸(끝난 칸만): 홀드 결과·대기열 진입
    const series = (metric: string, dim: string) => first.buckets.find((b) => b.metric === metric && b.dim === dim)?.points;
    expect(series('hold_result', 'HELD')).toEqual([{ secondMs: baseMs + 1_000, value: 3 }]);
    expect(series('hold_result', 'CONFLICT')).toEqual([{ secondMs: baseMs + 1_000, value: 1 }]);
    expect(series('queue_entries', '')).toEqual([
      { secondMs: baseMs, value: 100 },
      { secondMs: baseMs + 1_000, value: 50 },
    ]);
    // 새 판매 하나: 보드 주기가 읽어 다음 화면 조회에 보인다(화면 조회는 원천을 부르지 않는다)
    const soldAt = Date.now();
    await insert('rt.sale_event', [sale({ source: 'SEAT', type: 'SOLD', seat: 's4', tier: 'S', section: 'B', at: soldAt })]);
    let seenAt = 0;
    await expect
      .poll(
        async () => {
          const s = await board.snapshot(E);
          if (s.cumulative.soldSeats === 3 && seenAt === 0) seenAt = Date.now();
          return s.cumulative.soldSeats;
        },
        { timeout: 5_000, interval: 50 },
      )
      .toBe(3);
    const visibleMs = seenAt - soldAt;
    console.info(`F-04-1 ST-T10 ② 새 판매가 보드에 보이기까지 ${visibleMs}ms`);
    expect(visibleMs).toBeLessThan(2_000);
    // 조회 설정: 읽기마다 max_execution_time 1초를 보냈다
    await ch.exec('SYSTEM FLUSH LOGS');
    const settings = await ch.exec(
      "SELECT DISTINCT Settings['max_execution_time'] FROM system.query_log WHERE type = 'QueryFinish' AND query LIKE 'SELECT metric, dim, value FROM rt.v_cumulative%' FORMAT TSV",
    );
    expect(settings.trim()).toBe('1');
    const count = (await signals.querySeconds.get()).values.filter((v) => (v as { metricName?: string }).metricName === 'rt_query_seconds_count');
    const sum = (await signals.querySeconds.get()).values.filter((v) => (v as { metricName?: string }).metricName === 'rt_query_seconds_sum');
    const avgMs = Object.fromEntries(count.map((c) => [String(c.labels.view), Math.round((1_000 * (sum.find((s) => s.labels.view === c.labels.view)?.value ?? 0)) / Math.max(1, c.value))]));
    console.info(`F-04-1 rt_query_seconds 평균(ms) ${JSON.stringify(avgMs)}, 횟수 ${JSON.stringify(Object.fromEntries(count.map((c) => [String(c.labels.view), c.value])))}`);
    for (const view of ['v_cumulative', 'v_bucket', 'v_freshness']) expect(count.find((c) => c.labels.view === view)?.value ?? 0, view).toBeGreaterThan(0);
    expect((await signals.queryFailures.get()).values.reduce((n, v) => n + v.value, 0)).toBe(0);
  });

  test('F-04-1 ST-T2 ④ ops-svc 모든 파티션에 심장 박동이 오면 신선도가 5초 미만이고, 한 파티션을 멈추면 5초를 넘어 그 파티션을 가리킨다', async () => {
    await expect.poll(() => board.health().freshness.headSeconds, { timeout: 5_000, interval: 100 }).toBeLessThan(5);
    const fresh = board.health();
    console.info(`F-04-1 ST-T2 ④ 정상 신선도 ${JSON.stringify(fresh.freshness)}, p95 ${fresh.p95Seconds}`);
    expect(fresh.missingPartitions).toEqual([]);
    expect(fresh.pulses).toHaveLength(EXPECTED.length);
    stopped.add(`${STOPPED.topic}#${STOPPED.partition}`);
    const stoppedAt = Date.now();
    await expect.poll(() => board.health().freshness.cumulativeSeconds, { timeout: 15_000, interval: 100 }).toBeGreaterThan(5);
    const stale = board.health();
    console.info(`F-04-1 ST-T2 ④ 멈춘 뒤 ${Date.now() - stoppedAt}ms 신선도 ${JSON.stringify(stale.freshness)}`);
    expect(stale.stalestPartition).toEqual(STOPPED);
    expect((await board.snapshot(E)).freshness.cumulativeSeconds).toBeGreaterThan(5);
    stopped.clear();
    await expect.poll(() => board.health().freshness.headSeconds, { timeout: 5_000, interval: 100 }).toBeLessThan(5);
  });

  test('F-04-1 C-T20 ⑬ 파트너 REST가 관제 보드와 같은 누적·잔여석을 준다', async () => {
    const identity = new FakeIdentity();
    const owners: EventOwners = { find: async (id) => (id === E ? { promoterId: TENANT } : undefined) };
    const svc = await createService({
      name: 'ops-svc-rt-int',
      // 보드는 이 시험이 이미 돌리고 있다(모듈이 다시 켜지 않게 autoStart false)
      module: AppModule.register({ memory: true, realtimeTable: { board, owners, autoStart: false } }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: Date.now() }),
      logDestination: quiet(),
      adminAuthz: identity,
    });
    try {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/partner/events/${E}/live-snapshot`, headers: identity.partner(TENANT, 'partner_member') });
      expect(r.statusCode, r.payload).toBe(200);
      const body = JSON.parse(r.payload) as Record<string, unknown>;
      const consoleView = await board.snapshot(E);
      expect(body).toMatchObject({ sold: consoleView.cumulative.soldSeats, remaining: consoleView.remaining?.total, queueEntries: 150, waiting: 90 });
      expect(body.sold).toBe(3);
      expect(body.sections).toEqual([
        { sectionId: 'A', remaining: 9 },
        { sectionId: 'B', remaining: 18 },
      ]);
    } finally {
      // 모듈 닫기가 보드 주기를 끈다. 이 뒤에 보드를 쓰는 시험은 없다
      await svc.close();
    }
  });
});
