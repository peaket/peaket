// F-05-6 환급 잇기 배경 작업(EntryCloseDueTick) 단위 시험(BUILD_ORDER GAT-180, O-T29 ③).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 '환급 잇기'(1분 [가정]마다, 마감을 기다리는 보류 취소의 회차를 오래된 차례로 20개 [가정]까지,
// core-svc 판매 설정의 entryClosedAtMs가 있으면 그 회차의 그런 행을 조건부로 당긴다, core-svc를 읽지 못하면 아무것도 바꾸지 않는다),
// §7.4 운영 확인(purchase_entry_close_due_total{result}, result: moved·not_closed·unavailable), 계획 docs/review/plans/F-05-6.md §4.
// 저장소는 메모리 짝(MemoryEntryCloseDueStore)이고, 같은 계약 묶음(entry-close-due-store-contract.ts)을 실제 PostgreSQL 어댑터에도 돌린다.
// core-svc 자리(EntryCloseTimes)는 포트를 satisfies로 묶은 대역이다(null = 아직 마감 없음, undefined = 모름). 시계는 주입한 nowMs다.
// 새 모듈은 아직 없으므로 시험마다 동적으로 불러온다(구현 전에는 불러오기에서 시험마다 실패한다).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CAP, CLOSED_AT, entryCloseDueStoreContract, NOW, STARTS_AT, type DueRowSeed } from './entry-close-due-store-contract.js';

const load = async () => {
  const [tick, memory] = await Promise.all([import('../src/modules/refund/application/entry-close-due.js'), import('../src/modules/refund/adapters/memory-entry-close-due-store.js')]);
  return { ...tick, ...memory };
};
type Loaded = Awaited<ReturnType<typeof load>>;
/** 실제 포트 모양(EntryCloseTimes). 대역은 이 모양에 satisfies로 묶는다 */
type Times = ConstructorParameters<Loaded['EntryCloseDueTick']>[0]['closes'];
type Result = 'moved' | 'not_closed' | 'unavailable';

/** 메모리 짝에 심을 행. 칸 이름은 메모리 어댑터의 행 모양이다(계약의 DueRowSeed를 그대로 옮긴다) */
async function world() {
  const { MemoryEntryCloseDueStore } = await load();
  const store = new MemoryEntryCloseDueStore();
  return {
    store,
    seed: async (rows: readonly DueRowSeed[]) => {
      for (const r of rows) {
        store.put({
          cancellationId: r.cancellationId,
          eventId: r.eventId,
          status: r.status,
          refundDueAtMs: r.refundDueAtMs,
          entryRecordedAtMs: r.entryRecordedAtMs ?? null,
          eventCancellationRequestId: r.eventCancellationRequestId ?? null,
          createdAtMs: r.createdAtMs,
        });
      }
    },
    rowOf: async (cancellationId: string) => {
      const r = store.get(cancellationId);
      expect(r, cancellationId).toBeDefined();
      return { refundDueAtMs: r!.refundDueAtMs, status: r!.status };
    },
  };
}

entryCloseDueStoreContract('메모리 짝', world);

/** core-svc 판매 설정 entryClosedAtMs 대역. 묻는 회차를 적는다. 값이 함수면 그 함수가 답한다(던지기 등) */
function times(answers: Record<string, number | null | undefined | (() => Promise<number | null | undefined>)>) {
  const asked: string[] = [];
  const closes = {
    closedAtMs: async (eventId: string): Promise<number | null | undefined> => {
      asked.push(eventId);
      const a = answers[eventId];
      return typeof a === 'function' ? a() : a;
    },
  } satisfies Times;
  return { closes, asked };
}

/** 지표 대역: 결과마다 센다 */
function metricsOf() {
  const counts: Record<Result, number> = { moved: 0, not_closed: 0, unavailable: 0 };
  return { counts, metrics: { inc: (labels: { result: Result }) => void (counts[labels.result] += 1) } };
}

const row = (eventId: string, o: Partial<DueRowSeed> = {}, createdAtMs = STARTS_AT + 60_000): DueRowSeed => ({ cancellationId: randomUUID(), eventId, status: 'REQUESTED', refundDueAtMs: CAP, createdAtMs, ...o });

describe('환급 잇기 배경 작업 EntryCloseDueTick(O-T29 ③)', () => {
  test('O-T29 ③ 주기는 정본의 1분(60,000ms)이다', async () => {
    const { ENTRY_CLOSE_DUE_EVERY_MS } = await load();
    expect(ENTRY_CLOSE_DUE_EVERY_MS).toBe(60_000);
  });

  test('O-T29 ③ 마감이 있는 회차만 당기고(moved), 아직 없는 회차(null)는 not_closed, 모르는 회차(undefined)는 unavailable로 아무것도 바꾸지 않는다', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const closed = randomUUID();
    const open = randomUUID();
    const unknown = randomUUID();
    const r = { closedA: row(closed), closedSame: row(closed, { refundDueAtMs: CLOSED_AT }), open: row(open), unknown: row(unknown) };
    await w.seed(Object.values(r));
    const t = times({ [closed]: CLOSED_AT, [open]: null, [unknown]: undefined });
    const m = metricsOf();
    const tick = new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW, metrics: m.metrics });
    await expect(tick.run()).resolves.toEqual({ moved: 1 });
    expect([...t.asked].sort()).toEqual([closed, open, unknown].sort());
    expect((await w.rowOf(r.closedA.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    expect((await w.rowOf(r.closedSame.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    expect((await w.rowOf(r.open.cancellationId)).refundDueAtMs).toBe(CAP);
    expect((await w.rowOf(r.unknown.cancellationId)).refundDueAtMs).toBe(CAP);
    for (const s of Object.values(r)) expect((await w.rowOf(s.cancellationId)).status).toBe('REQUESTED');
    expect(m.counts).toEqual({ moved: 1, not_closed: 1, unavailable: 1 });
  });

  test('O-T29 ③ core-svc를 읽다 던지면 그 회차는 바꾸지 않고(unavailable) 다른 회차는 이어 당기며 틱은 실패로 끝나지 않는다', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const broken = randomUUID();
    const closed = randomUUID();
    // broken이 더 오래된 회차라 먼저 묻는다
    const b = row(broken, {}, STARTS_AT);
    const c = row(closed, { refundDueAtMs: CAP + 1 }, STARTS_AT + 1);
    await w.seed([b, c]);
    const t = times({ [broken]: () => Promise.reject(new Error('core-svc 503')), [closed]: CLOSED_AT });
    const m = metricsOf();
    await expect(new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW, metrics: m.metrics }).run()).resolves.toEqual({ moved: 1 });
    expect(t.asked).toEqual([broken, closed]);
    expect((await w.rowOf(b.cancellationId)).refundDueAtMs).toBe(CAP);
    expect((await w.rowOf(c.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    expect(m.counts).toEqual({ moved: 1, not_closed: 0, unavailable: 1 });
  });

  test('O-T29 ③ 한 틱은 오래된 회차 20개만 본다(21번째 회차는 묻지도 바꾸지도 않고 다음 틱에 본다)', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const events = Array.from({ length: 21 }, () => randomUUID());
    const rows = events.map((eventId, i) => row(eventId, { refundDueAtMs: CAP + i }, STARTS_AT + i * 1_000));
    await w.seed(rows);
    const t = times(Object.fromEntries(events.map((e) => [e, CLOSED_AT])));
    const tick = new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW });
    await expect(tick.run()).resolves.toEqual({ moved: 20 });
    expect(t.asked).toHaveLength(20);
    expect(new Set(t.asked)).toEqual(new Set(events.slice(0, 20)));
    expect((await w.rowOf(rows[20]!.cancellationId)).refundDueAtMs).toBe(CAP + 20);
    for (const r of rows.slice(0, 20)) expect((await w.rowOf(r.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    // 다음 틱이 남은 한 회차를 본다
    await expect(tick.run()).resolves.toEqual({ moved: 1 });
    expect(t.asked.at(-1)).toBe(events[20]);
    expect((await w.rowOf(rows[20]!.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
  });

  test('O-T29 ③ 마감을 끝내 모르는 오래된 회차 20개가 앞자리를 막아도, 마감된 새 회차 하나는 두 번째 틱에서 당겨진다(세 번째 틱은 다시 처음부터, 시험 리뷰 RV-06)', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const blocked = Array.from({ length: 20 }, () => randomUUID());
    const fresh = randomUUID();
    const freshRow = row(fresh, { refundDueAtMs: CAP + 3_600_000 }, STARTS_AT + 3_600_000);
    await w.seed([...blocked.map((e, i) => row(e, { refundDueAtMs: CAP + i }, STARTS_AT + i)), freshRow]);
    // 막는 회차는 절반은 아직 마감 전(null), 절반은 모름(undefined)
    const t = times({ ...Object.fromEntries(blocked.map((e, i) => [e, i % 2 === 0 ? null : undefined])), [fresh]: CLOSED_AT });
    const tick = new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW });
    await expect(tick.run()).resolves.toEqual({ moved: 0 });
    expect(new Set(t.asked)).toEqual(new Set(blocked));
    const asked = t.asked.length;
    await expect(tick.run()).resolves.toEqual({ moved: 1 });
    expect(t.asked.slice(asked)).toEqual([fresh]);
    expect((await w.rowOf(freshRow.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    const asked2 = t.asked.length;
    await expect(tick.run()).resolves.toEqual({ moved: 0 });
    expect(new Set(t.asked.slice(asked2))).toEqual(new Set(blocked));
  });

  test('O-T29 ③ 마감 시각을 읽었는데 당길 행이 0이어도(마감 시각이 refund_due_at보다 늦음) 그 회차 결과는 moved 하나이고 행은 그대로다(정본 §7.3 환급 잇기)', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const eventId = randomUUID();
    // 두 서비스 시계 차이: 기다리는 행의 refund_due_at(지금 + 10ms)보다 마감 시각(지금 + 20ms)이 늦다
    const r = row(eventId, { refundDueAtMs: NOW + 10 });
    await w.seed([r]);
    const t = times({ [eventId]: NOW + 20 });
    const m = metricsOf();
    await expect(new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW, metrics: m.metrics }).run()).resolves.toEqual({ moved: 0 });
    expect(t.asked).toEqual([eventId]);
    expect(m.counts).toEqual({ moved: 1, not_closed: 0, unavailable: 0 });
    expect((await w.rowOf(r.cancellationId)).refundDueAtMs).toBe(NOW + 10);
  });

  test('O-T29 ③ 기다리는 행의 기준은 주입한 지금 시각이다(refund_due_at이 지금 이하인 회차는 묻지 않는다)', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const due = randomUUID();
    const waiting = randomUUID();
    await w.seed([row(due, { refundDueAtMs: NOW }), row(waiting, { refundDueAtMs: NOW + 1 })]);
    const t = times({ [due]: CLOSED_AT, [waiting]: CLOSED_AT });
    await expect(new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW }).run()).resolves.toEqual({ moved: 1 });
    expect(t.asked).toEqual([waiting]);
  });

  test('O-T29 ③ 기다리는 행이 없으면 core-svc를 묻지 않고 0이다', async () => {
    const { EntryCloseDueTick } = await load();
    const w = await world();
    const t = times({});
    const m = metricsOf();
    await expect(new EntryCloseDueTick({ store: w.store, closes: t.closes, nowMs: () => NOW, metrics: m.metrics }).run()).resolves.toEqual({ moved: 0 });
    expect(t.asked).toEqual([]);
    expect(m.counts).toEqual({ moved: 0, not_closed: 0, unavailable: 0 });
  });
});
