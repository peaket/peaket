// 홀드 시도(telemetry.purchase HoldAttempt)의 Avro 바이트 시험(F-04-2 계획 §6 A-T26 ②·⑤, ADR-0357 결정 6·7·8, docs/features/seat-hold.md §3 '시도 하나의 내용', S-T35).
// 진짜 쓰임새(HoldSeats)를 메모리 저장소(좌석·좌석맵·구매 세션)로 돌리고, 시도는 운영 어댑터 KafkaHoldAttempts가 공용 인코더로 만들어 텔레메트리 버퍼에 넣는다.
// 버퍼(TelemetrySink.offer)만 시험 안의 대역이고, 받은 바이트는 시험 도구(packages/platform/test/produced-avro.ts, avsc + 계약 판 .avsc)로 푼다.
// 단언 값은 정본에서 적는다: 공통 판정 넷(A-T26), heldAt = 같은 홀드의 SeatEvent HELD occurredAt, retryNo = 그 구매 세션의 시도 차례(0·1·2…, 멱등 재생은 세지 않음),
// eventKey는 시도마다 다른 UUIDv7(결정 6), 키는 구매 세션 ID(docs/streaming.md §7), 계정 ID는 바이트에 없음(ASVS 14.2.4),
// 만들지 못한 시도는 버리고 telemetry_dropped_total{record="HoldAttempt"} 1·경고에 레코드·칸 이름만(결정 8, ASVS 16.2.5). 스키마 ID는 101.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { avroSchemas } from '@peaket/contracts/avro';
import { createAvroEncoder } from '@peaket/platform/avro';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { countUtf8, decodeProduced } from '../../../packages/platform/test/produced-avro.js';
import {
  HOLD_ATTEMPT_RECORD,
  HoldError,
  type HoldCommand,
  type HoldResult,
  HoldSeats,
  KafkaHoldAttempts,
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessions,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  noSeatSignals,
  type SeatStore,
  TELEMETRY_PURCHASE_TOPIC,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, newEvent, ref, type ReplayPort, replayOf, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { openInput } from './purchase-session-cases.js';

const SUBJECT = 'telemetry.purchase-peaket.telemetry.HoldAttempt';
const SCHEMA_ID = 101;
/** 밀리초 자리가 0이 아닌 시각(초 단위로 바꾸면 값이 달라진다) */
const NOW = Date.parse('2026-11-04T03:00:00.123Z');
const KEY = Buffer.alloc(32, 7);
const JNY_A = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const JNY_B = '0190f3a1-7c2e-7a00-8000-0000000000bb';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 홀드 Lua가 걸린 시간(잡은 시각과 시도 결과 시각이 갈리게) */
const HOLD_TAKES_MS = 7;

interface Offered {
  record: string;
  topic: string;
  key: string | null;
  value: Buffer;
}

async function world(o: { storeSessionB?: boolean; override?: (i: { seatIds: string[] }) => HoldResult | undefined } = {}) {
  const clock = fakeClock({ now: NOW, monotonic: 50 });
  const inner = new MemorySeatStore(clock);
  const seatMap = new MemorySeatMap();
  const sessions = new MemoryPurchaseSessions();
  const sessionStore = new MemoryPurchaseSessionStore(clock);
  const eventId = newEvent();
  const saleEndsAtMs = NOW + DAY;
  seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs }, SEAT_DEFS);
  await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  const opens: [string, string, string, string, boolean][] = [
    ['ps-a', ACCOUNT_A, 'ls-a', JNY_A, true],
    ['ps-b', ACCOUNT_B, 'ls-b', JNY_B, o.storeSessionB ?? true],
  ];
  for (const [sessionId, accountId, loginSessionId, journeyId, store] of opens) {
    sessions.open({ sessionId, accountId, eventId, journeyId, loginSessionId, key: KEY });
    if (store) expect((await sessionStore.open(openInput(clock, sessionId, { accountId, loginSessionId, eventId, journeyId }))).kind).toBe('CREATED');
  }
  // 좌석 저장소: 홀드 Lua가 HOLD_TAKES_MS 걸린 것으로 만들고, override가 정한 호출은 그 결과를 돌려준다(저장소 포트 경계)
  const replay = replayOf(inner);
  const store: SeatStore & ReplayPort = {
    hold: async (i, opt) => {
      const forced = o.override?.({ seatIds: i.seats.map((s) => s.seatId) });
      if (forced) return forced;
      const r = await inner.hold(i, opt);
      clock.advance(HOLD_TAKES_MS);
      return r;
    },
    holdAuto: async (i, opt) => {
      const r = await inner.holdAuto(i, opt);
      clock.advance(HOLD_TAKES_MS);
      return r;
    },
    autoCursor: (e, f) => inner.autoCursor(e, f),
    openSale: (i) => inner.openSale(i),
    replay: async (i) => replay(i),
  };
  const encoder = createAvroEncoder({ schemaIds: { [SUBJECT]: SCHEMA_ID }, schemas: avroSchemas, produces: [{ topic: TELEMETRY_PURCHASE_TOPIC, record: HOLD_ATTEMPT_RECORD }] });
  const offered: Offered[] = [];
  const dropped: [string, number][] = [];
  const warns: object[] = [];
  const pending: (() => Promise<void>)[] = [];
  const attempts = new KafkaHoldAttempts({
    encoder,
    offer: (record, topic, m) => void offered.push({ record, topic, key: m.key, value: m.value }),
    dropped: (record, n) => void dropped.push([record, n]),
    logger: { warn: (x) => void warns.push(x) },
    sessions: sessionStore,
    clock,
    // 뒤에서 하는 일은 모아 두었다가 flush에서 돌린다(응답 경로에서 기다리지 않는다)
    after: (work) => void pending.push(work),
  });
  const uc = new HoldSeats(store, seatMap, sessions, attempts, clock, noSeatSignals, sessionStore, undefined, undefined, undefined, seatMap);
  const run = (body: HoldCommand['body'], c: Partial<HoldCommand> = {}) => uc.execute({ eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: randomUUID(), body, ...c });
  const asB = (body: HoldCommand['body'], c: Partial<HoldCommand> = {}) => run(body, { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b', ...c });
  /** 뒤에서 할 일을 차례대로 끝낸다(시도 세기는 차례가 있다) */
  const flush = async () => {
    for (const w of pending.splice(0)) await w();
  };
  return { clock, inner, eventId, offered, dropped, warns, pending, run, asB, flush, ev: () => inner.db.event(eventId) };
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HoldError);
  expect((e as HoldError).code).toBe(code);
}

/** 버퍼가 받은 값 하나를 풀고 공통 판정 ①②③·키·계정 ID 없음(④)을 본다 */
function judged(o: Offered, purchaseSessionId: string) {
  expect([o.record, o.topic, o.key]).toEqual(['HoldAttempt', 'telemetry.purchase', purchaseSessionId]);
  const p = decodeProduced(o.value, HOLD_ATTEMPT_RECORD);
  expect([...o.value.subarray(0, 5)]).toEqual([0, 0, 0, 0, SCHEMA_ID]);
  expect(p.violations).toEqual([]);
  // 계약에 없는 계정 ID는 어느 계정의 것이든 바이트에 없다(업무 기록 HoldAttemptRecord에는 있다)
  expect(countUtf8(o.value, ACCOUNT_A)).toBe(0);
  expect(countUtf8(o.value, ACCOUNT_B)).toBe(0);
  return p.value;
}

describe('A-T26 ② 홀드 시도(telemetry.purchase)', () => {
  test('A-T26 ② [ASVS v5.0.0-14.2.4] 홀드 시도는 공통 판정을 만족하고 계정 ID가 바이트에 없다', async () => {
    const w = await world({ override: (i) => (i.seatIds.includes('A09') ? { kind: 'PAUSED' } : undefined) });
    await w.run({ seatIds: ['A02', 'A01'] });
    await w.asB({ seatIds: ['B01'] });
    await rejects(w.run({ seatIds: ['A03', 'B01'] }), 'CONFLICT');
    await rejects(w.run({ seatIds: ['B05', 'B06', 'B07'] }), 'QUOTA_EXCEEDED');
    w.ev().rel.set(ACCOUNT_A, new Map([[ref('A04').index, NOW + 30_000]]));
    await rejects(w.run({ seatIds: ['A04'] }), 'REHOLD_WAIT');
    await rejects(w.run({ seatIds: ['A09'] }), 'PAUSED');
    const auto = await w.asB({ auto: { firstTierId: 'R', count: 2, wheelchair: false, allowSplit: false } });
    for (let i = 0; i < 30; i++) w.ev().bits.add(i);
    await rejects(w.asB({ auto: { firstTierId: 'R', secondTierId: 'S', count: 1, wheelchair: false, allowSplit: false } }), 'MANUAL_SELECTION_REQUIRED');
    // 응답이 나간 뒤에야 시도를 낸다(응답 경로에서 세기·인코딩을 기다리지 않는다)
    expect(w.offered).toEqual([]);
    await w.flush();

    expect(w.dropped).toEqual([]);
    expect(w.warns).toEqual([]);
    const sessionsOf = ['ps-a', 'ps-b', 'ps-a', 'ps-a', 'ps-a', 'ps-a', 'ps-b', 'ps-b'];
    expect(w.offered).toHaveLength(sessionsOf.length);
    const v = w.offered.map((o, i) => judged(o, sessionsOf[i]!));
    const pick = (x: Record<string, unknown>) => [x.mode, x.result, x.seatIds, x.autoResult];
    expect(v.map(pick)).toEqual([
      ['PICK', 'HELD', ['A02', 'A01'], null],
      ['PICK', 'HELD', ['B01'], null],
      ['PICK', 'CONFLICT', ['A03', 'B01'], null],
      ['PICK', 'LIMIT', ['B05', 'B06', 'B07'], null],
      ['PICK', 'RECENTLY_RELEASED', ['A04'], null],
      ['PICK', 'ERROR', ['A09'], null],
      ['AUTO', 'HELD', [...auto.seatIds], auto.assignResult],
      // 후보가 없어 수동 선택으로 넘긴 자동 배정: 잡은 좌석이 없다(seatIds는 PICK이거나 HELD일 때만)
      ['AUTO', 'ERROR', null, 'MANUAL_REQUIRED'],
    ]);
    expect(auto.assignResult).toBe('FIRST');
    for (const [i, x] of v.entries()) {
      expect(x, String(i)).toMatchObject({ eventId: w.eventId, purchaseSessionId: sessionsOf[i], journeyId: sessionsOf[i] === 'ps-a' ? JNY_A : JNY_B });
      // 잡은 시각은 HELD에만
      expect(x.heldAt === null, String(i)).toBe(x.result !== 'HELD');
    }
    // 첫 좌석의 등급·구역(PICK), 자동 배정은 잡은 첫 좌석의 것, 못 잡았으면 희망 1순위 등급
    expect(v.map((x) => x.tierId)).toEqual(['R', 'S', 'R', 'S', 'R', 'R', 'R', 'R']);
    expect(v[0]).toMatchObject({ sectionId: 'SEC-A', firstHeldInSession: true });
  });

  test('A-T26 ② heldAt은 같은 홀드의 SeatEvent HELD occurredAt과 같고 retryNo는 0, 1, 2다', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.run({ seatIds: ['A02', 'A01'] }, { idempotencyKey: key });
    // 멱등 재생은 시도가 아니다(기록하지 않고 세지 않는다)
    await w.run({ seatIds: ['A02', 'A01'] }, { idempotencyKey: key });
    await w.asB({ seatIds: ['A05'] });
    await rejects(w.run({ seatIds: ['A05'] }), 'CONFLICT');
    const third = await w.run({ seatIds: ['A07'] });
    await w.flush();

    const a = w.offered.filter((o) => o.key === 'ps-a').map((o) => judged(o, 'ps-a'));
    expect(a.map((x) => [x.result, x.retryNo])).toEqual([
      ['HELD', 0],
      ['CONFLICT', 1],
      ['HELD', 2],
    ]);
    // 다른 구매 세션은 따로 센다
    expect(w.offered.filter((o) => o.key === 'ps-b').map((o) => judged(o, 'ps-b').retryNo)).toEqual([0]);
    // heldAt = 그 홀드가 좌석 사건 줄에 남긴 HELD occurredAt(밀리초 그대로)
    const heldAtOf = (holdId: string) => [...new Set(w.ev().stream.filter((s) => s.type === 'HELD' && s.holdId === holdId).map((s) => Number(s.occurredAtMs)))];
    expect(heldAtOf(first.holdId)).toEqual([NOW]);
    expect(a[0]!.heldAt).toBe(NOW);
    expect(heldAtOf(third.holdId)).toEqual([a[2]!.heldAt]);
    // 결과 시각은 홀드 Lua가 끝난 뒤(잡은 시각과 다른 칸이다)
    expect(a[0]!.occurredAt).toBe(NOW + HOLD_TAKES_MS);
    expect(a[2]!.firstHeldInSession).toBe(false);
    // eventKey는 시도마다 다른 UUIDv7
    const keys = w.offered.map((o) => decodeProduced(o.value, HOLD_ATTEMPT_RECORD).value.eventKey as string);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const k of keys) expect(k).toMatch(UUID_V7);
  });
});

describe('A-T26 ⑤ 만들지 못한 홀드 시도(ADR-0357 결정 8)', () => {
  test('A-T26 ⑤ [ASVS v5.0.0-16.2.5] 만들지 못한 홀드 시도는 버리고 세며 로그에 값이 없다', async () => {
    const w = await world({ storeSessionB: false });
    // 좌석맵 판에 없는 좌석: 첫 좌석을 찾기 전에 거절해 tierId가 빈 ERROR 시도(필수 칸이 빔)
    await rejects(w.run({ seatIds: ['Z99'] }), 'INVALID_SEAT');
    await w.flush();
    expect(w.offered).toEqual([]);
    expect(w.dropped).toEqual([['HoldAttempt', 1]]);
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]).toMatchObject({ kind: 'telemetry-dropped', record: 'HoldAttempt', fields: ['tierId'] });
    // 구매 세션 상태가 없어 시도를 셀 수 없다(null): 같은 결과
    await w.asB({ seatIds: ['B02'] });
    await w.flush();
    expect(w.offered).toEqual([]);
    expect(w.dropped).toEqual([
      ['HoldAttempt', 1],
      ['HoldAttempt', 1],
    ]);
    expect(w.warns).toHaveLength(2);
    expect(w.warns[1]).toMatchObject({ kind: 'telemetry-dropped', record: 'HoldAttempt' });
    // 경고 로그에 계정·구매 세션·좌석·회차·여정 값이 없다(레코드·칸 이름과 사유만)
    const text = JSON.stringify(w.warns);
    for (const banned of [ACCOUNT_A, ACCOUNT_B, 'ps-a', 'ps-b', 'Z99', 'B02', w.eventId, JNY_A, JNY_B]) expect(text.includes(banned), banned).toBe(false);
    // 정상 시도 하나는 낸다(빈 결과가 통과로 새지 않게). 버린 시도는 세지 않아 retryNo 0이다
    await w.run({ seatIds: ['A01'] });
    await w.flush();
    expect(w.offered).toHaveLength(1);
    expect(judged(w.offered[0]!, 'ps-a')).toMatchObject({ result: 'HELD', retryNo: 0 });
    expect(w.dropped).toHaveLength(2);
  });
});
