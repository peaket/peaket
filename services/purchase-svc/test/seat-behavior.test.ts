// 좌석 화면 행동 요약(docs/features/seat-hold.md §3 '좌석 화면 행동 요약', docs/features/bot-defense.md §4.1, ADR-0171 결정 4, ADR-0249 결정 6, B-T19).
// 구매 세션마다 처음 받은 요약 하나만 낸다. 홀드 결과와 상관없고, 내보내기가 실패해도 홀드를 막지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BehaviorSignal } from '@peaket/contracts/asyncapi';
import { avroSchemas } from '@peaket/contracts/avro';
import { fakeClock } from '@peaket/platform';
import { createAvroEncoder } from '@peaket/platform/avro';
import { describe, expect, test } from 'vitest';
import { countUtf8, decodeProduced } from '../../../packages/platform/test/produced-avro.js';
import { AvroBehaviorSignals } from '../src/modules/inventory/adapters/avro-behavior-signals.js';
import { SeatBehaviorReporter } from '../src/modules/inventory/application/seat-behavior.js';
import { type BehaviorSignalRecord, HoldSeats, type HoldCommand, MemoryPurchaseSessions, MemorySeatMap, MemorySeatStore, RecordingHoldAttempts } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.UTC(2026, 10, 9, 3, 0, 0);
const PID = 'pid-a';
const JOURNEY = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const SUMMARY = { v: 1, windowMs: 2_000, pointerMoves: 12, pointerEntropy: 1.5, scrollEvents: 1, scrollDistancePx: 80 } as const;

async function world(o: { claim?: () => Promise<boolean | null> } = {}) {
  const clock = fakeClock({ now: NOW });
  const inner = new MemorySeatStore(clock);
  const seatMap = new MemorySeatMap();
  const sessions = new MemoryPurchaseSessions();
  const attempts = new RecordingHoldAttempts();
  const eventId = newEvent();
  const saleEndsAtMs = NOW + DAY;
  seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs }, SEAT_DEFS);
  await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + DAY });
  sessions.open({ sessionId: 'ps-a', accountId: ACCOUNT_A, eventId, journeyId: JOURNEY, loginSessionId: 'ls-a', key: new Uint8Array(32) });
  const signals: BehaviorSignalRecord[] = [];
  const claimed = new Set<string>();
  const pending: Promise<void>[] = [];
  const reporter = new SeatBehaviorReporter({
    claims: {
      claimSeatBehavior: o.claim ?? (async (jti) => {
        if (claimed.has(jti)) return false;
        claimed.add(jti);
        return true;
      }),
    },
    signals: { record: (r) => void signals.push(r) },
    clock,
    after: (w) => void pending.push(w()),
  });
  const uc = new HoldSeats(inner, seatMap, sessions, attempts, clock, undefined, undefined, undefined, reporter);
  const run = (body: HoldCommand['body'], c: Partial<HoldCommand> = {}) => uc.execute({ eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: randomUUID(), body, pid: PID, ...c });
  const flush = async () => {
    await Promise.all(pending.splice(0));
  };
  sessions.open({ sessionId: 'ps-b', accountId: ACCOUNT_B, eventId, journeyId: JOURNEY, loginSessionId: 'ls-b', key: new Uint8Array(32) });
  return { uc, run, flush, signals, eventId, inner };
}

describe('좌석 화면 행동 요약(B-T19)', () => {
  test('[B-T19] [S-T36] 첫직접선택홀드의요약을_screen SEAT인BehaviorSignal한건으로낸다(netClass·asn·기기가명없음)', async () => {
    const w = await world();
    await w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } });
    await w.flush();
    expect(w.signals).toHaveLength(1);
    expect(w.signals[0]).toMatchObject({ screen: 'SEAT', pid: PID, eventId: w.eventId, journeyId: JOURNEY, tsMs: NOW });
    expect(w.signals[0]!.features).toEqual(SUMMARY);
  });

  test('[B-T19] [S-T36] 같은세션의뒤홀드에실린요약은_버린다', async () => {
    const w = await world();
    await w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } });
    await w.run({ seatIds: ['A02'], behavior: { ...SUMMARY } });
    await w.flush();
    expect(w.signals).toHaveLength(1);
  });

  test('[B-T19] [S-T36] 경합으로진홀드의요약도내고_다음홀드의요약은_같은세션이라늘지않는다', async () => {
    const w = await world();
    await w.run({ seatIds: ['A01'] }, { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b' });
    await expect(w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } })).rejects.toThrow();
    await w.run({ seatIds: ['A02'], behavior: { ...SUMMARY, windowMs: 9_000 } });
    await w.flush();
    expect(w.signals).toHaveLength(1);
    expect(w.signals[0]!.features).toEqual(SUMMARY);
  });

  test('[B-T19] [S-T36] 같은멱등키로요약만바꿔보내도_처음응답을받고신호가늘지않는다', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } }, { idempotencyKey: key });
    const again = await w.run({ seatIds: ['A01'], behavior: { ...SUMMARY, windowMs: 1 } }, { idempotencyKey: key });
    await w.flush();
    expect(again).toEqual(first);
    expect(w.signals).toHaveLength(1);
  });

  test('[B-T19] 요약이없는홀드는_신호를내지않는다', async () => {
    const w = await world();
    await w.run({ seatIds: ['A01'] });
    await w.flush();
    expect(w.signals).toEqual([]);
  });

  test('[B-T19] [S-T36] 자동배정요청에는_SEAT신호가없다', async () => {
    const w = await world();
    await w.run({ auto: { firstTierId: 'T', count: 1, wheelchair: false, allowSplit: false }, behavior: { ...SUMMARY } }).catch(() => undefined);
    await w.flush();
    expect(w.signals).toEqual([]);
  });

  test('[B-T19] pid가없거나_여정ID가없으면_내지않는다', async () => {
    const w = await world();
    const { pid: _gone, ...noPid } = { eventId: w.eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: randomUUID(), body: { seatIds: ['A02'], behavior: { ...SUMMARY } }, pid: 'x' };
    await w.uc.execute(noPid);
    await w.flush();
    expect(w.signals).toEqual([]);
  });

  test('[B-T19] 요약을낸표시를못잡아도_홀드는그대로성공한다(응답을막지않는다)', async () => {
    const w = await world({ claim: () => Promise.reject(new Error('Redis 장애')) });
    await expect(w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } })).resolves.toMatchObject({ seatIds: ['A01'] });
    await w.flush();
    expect(w.signals).toEqual([]);
  });

  test('[B-T19] 세션이없어표시를못잡으면(null)_내지않는다', async () => {
    const w = await world({ claim: async () => null });
    await w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } });
    await w.flush();
    expect(w.signals).toEqual([]);
  });
});

// 값은 공용 Avro 인코더로 만든 Confluent 형식 바이트다(ADR-0357 결정 3·9, F-04-2). 받은 바이트는 시험 도구(produced-avro.ts)가 계약 판 .avsc로 풀고,
// 푼 값에서 null(싣지 않은 선택 칸)을 걷어 asyncapi 모양으로 되돌린 뒤 계약 Zod(BehaviorSignal)로도 본다. 스키마 ID는 44
const BEHAVIOR_SUBJECT = 'telemetry.behavior-peaket.telemetry.BehaviorSignal';
const BEHAVIOR_RECORD = 'peaket.telemetry.BehaviorSignal';
const BEHAVIOR_SCHEMA_ID = 44;

/** 푼 값에서 null 칸을 걷고 timestamp-millis를 ISO 글로 되돌린다(asyncapi 모양) */
function asyncapiShape(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null) continue;
    if (k === 'ts') out[k] = new Date(x as number).toISOString();
    else if (k === 'features') out[k] = Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => y !== null));
    else out[k] = x;
  }
  return out;
}

function behaviorWorld() {
  const offered: { record: string; topic: string; key: string | null; bytes: Buffer; value: Record<string, unknown> }[] = [];
  const dropped: [string, number][] = [];
  const warns: object[] = [];
  const encoder = createAvroEncoder({ schemaIds: { [BEHAVIOR_SUBJECT]: BEHAVIOR_SCHEMA_ID }, schemas: avroSchemas, produces: [{ topic: 'telemetry.behavior', record: BEHAVIOR_RECORD }] });
  const signals = new AvroBehaviorSignals({
    offer: (record, topic, m) => {
      const p = decodeProduced(m.value, BEHAVIOR_RECORD);
      expect(p.schemaId).toBe(BEHAVIOR_SCHEMA_ID);
      expect(p.violations).toEqual([]);
      offered.push({ record, topic, key: m.key, bytes: m.value, value: asyncapiShape(p.value) });
    },
    encoder,
    dropped: (r, n) => void dropped.push([r, n]),
    logger: { warn: (x) => void warns.push(x) },
  });
  return { offered, dropped, warns, signals };
}

describe('AvroBehaviorSignals(B-T19)', () => {
  const rec = (o: Partial<BehaviorSignalRecord> = {}): BehaviorSignalRecord => ({ eventKey: '0190f3a1-7c2e-7a00-8000-000000000bbb', screen: 'SEAT', pid: PID, eventId: 'ev-1', journeyId: JOURNEY, features: { ...SUMMARY }, tsMs: NOW, ...o });

  test.each(['SEAT', 'PAYMENT'] as const)('[B-T19] screen %s는_계약모양이고_키는pid이며_netClass·asn·deviceRef가없다', (screen) => {
    const w = behaviorWorld();
    w.signals.record(rec({ screen }));
    expect(w.offered[0]).toMatchObject({ record: 'BehaviorSignal', topic: 'telemetry.behavior', key: PID });
    expect(BehaviorSignal.safeParse(w.offered[0]!.value).success, JSON.stringify(w.offered[0]!.value)).toBe(true);
    for (const k of ['netClass', 'asn', 'deviceRef']) expect(w.offered[0]!.value[k], k).toBeUndefined();
    expect(w.offered[0]!.value).toMatchObject({ screen, features: SUMMARY, refMissing: false });
  });

  test('[B-T19] 최댓값[가정]을넘는요약칸은_내보내지않는다', () => {
    const w = behaviorWorld();
    w.signals.record(rec({ features: { v: 1, windowMs: 10, pointerMoves: 1_000_001, pointerEntropy: 3.001, inputIntervalMeanMs: 3_600_001, inputIntervalStdMs: 3_600_001, scrollEvents: 1_000_001, scrollDistancePx: 1_000_000_001 } }));
    expect(w.offered[0]!.value.features).toEqual({ v: 1, windowMs: 10 });
  });

  test('[B-T19] 요약에_정해지지않은칸이끼어도_나가지않는다', () => {
    const w = behaviorWorld();
    w.signals.record(rec({ features: { v: 1, windowMs: 10, coords: [1, 2] } as never }));
    expect(w.offered[0]!.value.features).toEqual({ v: 1, windowMs: 10 });
  });
});

describe('A-T26 ③ 좌석·결제 화면 행동 신호(telemetry.behavior)', () => {
  test('A-T26 ③ 좌석·결제 화면 행동 신호가 공통 판정을 만족한다', async () => {
    // 좌석 화면: 진짜 쓰임새(HoldSeats → SeatBehaviorReporter)가 만든 기록을 운영 어댑터(AvroBehaviorSignals)가 낸다
    const b = behaviorWorld();
    const w = await world();
    await w.run({ seatIds: ['A01'], behavior: { ...SUMMARY } });
    await w.flush();
    expect(w.signals).toHaveLength(1);
    b.signals.record(w.signals[0]!);
    // 결제 화면: 같은 어댑터에 screen PAYMENT
    b.signals.record({ ...w.signals[0]!, screen: 'PAYMENT', eventKey: '0190f3a1-7c2e-7a00-8000-000000000ccc' });
    expect(b.dropped).toEqual([]);
    expect(b.offered.map((o) => [o.record, o.topic, o.key, o.value.screen])).toEqual([
      ['BehaviorSignal', 'telemetry.behavior', PID, 'SEAT'],
      ['BehaviorSignal', 'telemetry.behavior', PID, 'PAYMENT'],
    ]);
    for (const o of b.offered) {
      // 계약 모양 그대로(Zod)이고, 회차·여정·시각이 그 기록의 것이다
      expect(BehaviorSignal.safeParse(o.value).success, JSON.stringify(o.value)).toBe(true);
      expect(o.value).toMatchObject({ pid: PID, eventId: w.eventId, journeyId: JOURNEY, refMissing: false, ts: new Date(NOW).toISOString(), features: SUMMARY });
      // netClass·asn·기기 가명은 purchase-svc가 모른다(asyncapi: netClass는 LOBBY·EVENT_DETAIL에만)
      for (const k of ['netClass', 'asn', 'deviceRef']) expect(o.value[k], k).toBeUndefined();
      // 계약에 없는 계정 ID는 바이트에 없다
      expect(countUtf8(o.bytes, ACCOUNT_A)).toBe(0);
    }
  });

  test('A-T26 ⑤ 계약을 채우지 못한 좌석 행동 신호는 버리고 세며 경고에 값이 없다', () => {
    const b = behaviorWorld();
    // 필수 칸 screen이 기호 목록 밖
    b.signals.record({ eventKey: '0190f3a1-7c2e-7a00-8000-000000000ddd', screen: 'LOBBY_X' as never, pid: PID, eventId: 'ev-secret-1', journeyId: JOURNEY, features: { ...SUMMARY }, tsMs: NOW });
    expect(b.offered).toEqual([]);
    expect(b.dropped).toEqual([['BehaviorSignal', 1]]);
    expect(b.warns).toEqual([{ kind: 'telemetry-encode-failed', record: 'BehaviorSignal', fields: ['screen'] }]);
    const text = JSON.stringify(b.warns);
    for (const banned of [PID, 'ev-secret-1', JOURNEY]) expect(text.includes(banned), banned).toBe(false);
  });
});
