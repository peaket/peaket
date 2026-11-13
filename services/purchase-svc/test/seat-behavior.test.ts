// 좌석 화면 행동 요약(docs/features/seat-hold.md §3 '좌석 화면 행동 요약', docs/features/bot-defense.md §4.1, ADR-0171 결정 4, ADR-0249 결정 6, B-T19).
// 구매 세션마다 처음 받은 요약 하나만 낸다. 홀드 결과와 상관없고, 내보내기가 실패해도 홀드를 막지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BehaviorSignal } from '@peaket/contracts/asyncapi';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JsonBehaviorSignals } from '../src/modules/inventory/adapters/json-behavior-signals.js';
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

describe('JsonBehaviorSignals(B-T19)', () => {
  const rec = (o: Partial<BehaviorSignalRecord> = {}): BehaviorSignalRecord => ({ eventKey: '0190f3a1-7c2e-7a00-8000-000000000bbb', screen: 'SEAT', pid: PID, eventId: 'ev-1', journeyId: JOURNEY, features: { ...SUMMARY }, tsMs: NOW, ...o });

  test.each(['SEAT', 'PAYMENT'] as const)('[B-T19] screen %s는_계약모양이고_키는pid이며_netClass·asn·deviceRef가없다', (screen) => {
    const offered: { record: string; topic: string; key: string | null; value: Record<string, unknown> }[] = [];
    new JsonBehaviorSignals({ offer: (record, topic, m) => offered.push({ record, topic, key: m.key, value: JSON.parse(m.value.toString('utf8')) as Record<string, unknown> }) }).record(rec({ screen }));
    expect(offered[0]).toMatchObject({ record: 'BehaviorSignal', topic: 'telemetry.behavior', key: PID });
    expect(BehaviorSignal.safeParse(offered[0]!.value).success, JSON.stringify(offered[0]!.value)).toBe(true);
    for (const k of ['netClass', 'asn', 'deviceRef']) expect(offered[0]!.value[k], k).toBeUndefined();
    expect(offered[0]!.value).toMatchObject({ screen, features: SUMMARY, refMissing: false });
  });

  test('[B-T19] 최댓값[가정]을넘는요약칸은_내보내지않는다', () => {
    const offered: Record<string, unknown>[] = [];
    new JsonBehaviorSignals({ offer: (_r, _t, m) => offered.push(JSON.parse(m.value.toString('utf8')) as Record<string, unknown>) }).record(rec({ features: { v: 1, windowMs: 10, pointerMoves: 1_000_001, pointerEntropy: 3.001, inputIntervalMeanMs: 3_600_001, inputIntervalStdMs: 3_600_001, scrollEvents: 1_000_001, scrollDistancePx: 1_000_000_001 } }));
    expect(offered[0]!.features).toEqual({ v: 1, windowMs: 10 });
  });

  test('[B-T19] 요약에_정해지지않은칸이끼어도_나가지않는다', () => {
    const offered: Record<string, unknown>[] = [];
    new JsonBehaviorSignals({ offer: (_r, _t, m) => offered.push(JSON.parse(m.value.toString('utf8')) as Record<string, unknown>) }).record(rec({ features: { v: 1, windowMs: 10, coords: [1, 2] } as never }));
    expect(offered[0]!.features).toEqual({ v: 1, windowMs: 10 });
  });
});
