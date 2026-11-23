// 환급 잇기 저장소(EntryCloseDueStore 포트)의 waitingEvents·pullDue 계약 시험 묶음(F-05-6, O-T29 ③, BUILD_ORDER GAT-180).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 '환급 잇기'(마감을 기다리는 보류 취소 = order_cancellation이 REQUESTED이고
// entry_recorded_at·event_cancellation_request_id가 비고 refund_due_at이 지금보다 뒤. 그 회차를 오래된 차례로 20개 [가정]까지 고른다.
// 마감 시각이 있으면 그 회차의 그런 행에 refund_due_at을 그 값으로 조건부 갱신한다(refund_due_at이 그 값보다 뒤일 때만)),
// docs/data.md order_cancellation.refund_due_at, 계획 docs/review/plans/F-05-6.md §4(waitingEvents(nowMs, limit) → 회차 ID, pullDue(eventId, closedAtMs) → 바꾼 행 수).
// 같은 묶음을 메모리 짝(단위, test/entry-close-due.test.ts)과 실제 PostgreSQL 어댑터(통합, test-int/entry-close-due.int.test.ts)에 돌린다(짝 가짜의 행동 짝).
// '지우거나 옮기는 연산은 건드린 행을 모두 확인한다'(architecture §8.6 자주 놓친 결함): pullDue 뒤 심은 행 모두의 refund_due_at·상태를 단언한다.
// 시험 파일이 아니라 두 시험 파일이 부르는 모듈이다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { EntryCloseDueStore } from '../src/modules/refund/application/entry-close-due.js';

/** 심을 취소 행 한 줄(바깥에서 보이는 칸만) */
export interface DueRowSeed {
  readonly cancellationId: string;
  readonly eventId: string;
  readonly status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
  readonly refundDueAtMs: number | null;
  readonly entryRecordedAtMs?: number;
  readonly eventCancellationRequestId?: string;
  /** 접수 시각. '오래된 차례'를 refund_due_at과 같은 차례로 두려고 함께 늘린다 */
  readonly createdAtMs: number;
}

export interface EntryCloseDueWorld {
  store: EntryCloseDueStore;
  /** 행을 심는다(주문·회차는 하네스가 만든다) */
  seed(rows: readonly DueRowSeed[]): Promise<void>;
  /** 그 취소 행의 지금 refund_due_at(밀리초, 비었으면 null)과 상태 */
  rowOf(cancellationId: string): Promise<{ refundDueAtMs: number | null; status: string }>;
}

const HOUR = 3_600_000;
/** 공연 시작(분 경계가 아닌 값) */
export const STARTS_AT = Date.parse('2026-12-24T10:00:07.311Z');
/** 정본: 취소 때 쓰는 마감은 공연 시작 + 50시간(data.md order_cancellation.refund_due_at)의 상한이다 */
export const CAP = STARTS_AT + 50 * HOUR;
/** 정본: 역할 유효 끝 = ends_at + 2시간. ends_at은 공연 시작 + 2시간 13분 7.411초로 골랐다 */
export const ENDS_AT = STARTS_AT + 2 * HOUR + 13 * 60_000 + 7_411;
/** 마감 시각(역할 유효 끝 + 61,003ms) */
export const CLOSED_AT = ENDS_AT + 2 * HOUR + 61_003;
/** 배경 작업 판단 시각(마감 뒤 30초, 정본 '1분 [가정]마다') */
export const NOW = CLOSED_AT + 30_000;

const row = (eventId: string, o: Partial<DueRowSeed> = {}, createdAtMs = STARTS_AT + 60_000): DueRowSeed => ({
  cancellationId: randomUUID(),
  eventId,
  status: 'REQUESTED',
  refundDueAtMs: CAP,
  createdAtMs,
  ...o,
});

export function entryCloseDueStoreContract(name: string, make: () => Promise<EntryCloseDueWorld> | EntryCloseDueWorld): void {
  describe(`O-T29 ③ 환급 잇기 저장소 waitingEvents·pullDue 계약(${name})`, () => {
    test(`O-T29 ③ waitingEvents는 REQUESTED∧입장 기록 없음∧회차 취소 아님∧refund_due_at > 지금인 행이 있는 회차만 준다(경계: 지금과 같으면 빼고 1ms 뒤면 넣는다)(${name})`, async () => {
      const w = await make();
      const waiting = randomUUID();
      const edgeIn = randomUUID();
      const others = { pending: randomUUID(), entered: randomUUID(), eventCancel: randomUUID(), dueNow: randomUUID(), duePast: randomUUID(), dueNull: randomUUID(), refunded: randomUUID(), voided: randomUUID() };
      await w.seed([
        row(waiting),
        row(edgeIn, { refundDueAtMs: NOW + 1 }),
        row(others.pending, { status: 'REFUND_PENDING' }),
        row(others.entered, { entryRecordedAtMs: STARTS_AT + 60_000, refundDueAtMs: CAP }),
        row(others.eventCancel, { eventCancellationRequestId: randomUUID() }),
        row(others.dueNow, { refundDueAtMs: NOW }),
        row(others.duePast, { refundDueAtMs: NOW - 1 }),
        row(others.dueNull, { refundDueAtMs: null }),
        row(others.refunded, { status: 'REFUNDED', refundDueAtMs: CAP }),
        row(others.voided, { status: 'VOIDED', refundDueAtMs: CAP }),
      ]);
      const got = await w.store.waitingEvents(NOW, 20);
      expect([...got].sort()).toEqual([waiting, edgeIn].sort());
    });

    test(`O-T29 ③ waitingEvents는 회차를 오래된 차례로 limit개까지 주고 한 회차를 한 번만 준다(21개 중 20개, 가장 새 회차가 빠진다)(${name})`, async () => {
      const w = await make();
      const events = Array.from({ length: 21 }, () => randomUUID());
      const rows: DueRowSeed[] = [];
      events.forEach((eventId, i) => {
        // 회차마다 두 행(같은 회차가 두 번 나오지 않는지). 오래된 차례 = 접수·마감 상한이 이른 차례
        rows.push(row(eventId, { refundDueAtMs: CAP + i * 60_000 }, STARTS_AT + i * 60_000));
        rows.push(row(eventId, { refundDueAtMs: CAP + i * 60_000 + 1 }, STARTS_AT + i * 60_000 + 1));
      });
      // 심는 차례를 섞는다(넣은 차례에 기대지 않게)
      await w.seed([...rows].reverse());
      const got = await w.store.waitingEvents(NOW, 20);
      expect(got).toEqual(events.slice(0, 20));
      expect(await w.store.waitingEvents(NOW, 21)).toEqual(events);
    });

    test(`O-T29 ③ pullDue는 그 회차의 REQUESTED∧입장 기록 없음∧회차 취소 아님∧refund_due_at > 마감인 행만 마감 시각으로 당기고 바꾼 행 수를 준다(건드린 행 모두 단언)(${name})`, async () => {
      const w = await make();
      const eventId = randomUUID();
      const otherEvent = randomUUID();
      const enteredAt = STARTS_AT + 5 * 60_000;
      const requestId = randomUUID();
      const r = {
        cap: row(eventId),
        later: row(eventId, { refundDueAtMs: CLOSED_AT + 1 }),
        same: row(eventId, { refundDueAtMs: CLOSED_AT }),
        earlier: row(eventId, { refundDueAtMs: CLOSED_AT - 1 }),
        dueNull: row(eventId, { refundDueAtMs: null }),
        pending: row(eventId, { status: 'REFUND_PENDING', refundDueAtMs: CAP }),
        entered: row(eventId, { entryRecordedAtMs: enteredAt, refundDueAtMs: CAP }),
        eventCancel: row(eventId, { eventCancellationRequestId: requestId }),
        voided: row(eventId, { status: 'VOIDED', refundDueAtMs: CAP }),
        other: row(otherEvent),
      };
      await w.seed(Object.values(r));
      expect(await w.store.pullDue(eventId, CLOSED_AT)).toBe(2);
      const after = async (s: DueRowSeed) => (await w.rowOf(s.cancellationId)).refundDueAtMs;
      expect(await after(r.cap)).toBe(CLOSED_AT);
      expect(await after(r.later)).toBe(CLOSED_AT);
      expect(await after(r.same)).toBe(CLOSED_AT);
      expect(await after(r.earlier)).toBe(CLOSED_AT - 1);
      expect(await after(r.dueNull)).toBeNull();
      expect(await after(r.pending)).toBe(CAP);
      expect(await after(r.entered)).toBe(CAP);
      expect(await after(r.eventCancel)).toBe(CAP);
      expect(await after(r.voided)).toBe(CAP);
      expect(await after(r.other)).toBe(CAP);
      // 상태는 하나도 바꾸지 않는다(환급 자체는 지금의 환급 실행기 몫)
      for (const s of Object.values(r)) expect((await w.rowOf(s.cancellationId)).status, s.cancellationId).toBe(s.status);
      // 다시 불러도 결과가 같다(0행)
      expect(await w.store.pullDue(eventId, CLOSED_AT)).toBe(0);
      // 당긴 회차는 더 기다리지 않는다(refund_due_at이 지금보다 앞), 다른 회차는 그대로 기다린다
      expect(await w.store.waitingEvents(NOW, 20)).toEqual([otherEvent]);
    });

    test(`O-T29 ③ pullDue는 더 늦은 마감 시각으로는 이미 당긴 행을 늦추지 않는다(${name})`, async () => {
      const w = await make();
      const eventId = randomUUID();
      const a = row(eventId);
      await w.seed([a]);
      expect(await w.store.pullDue(eventId, CLOSED_AT)).toBe(1);
      expect(await w.store.pullDue(eventId, CLOSED_AT + 3_600_000)).toBe(0);
      expect((await w.rowOf(a.cancellationId)).refundDueAtMs).toBe(CLOSED_AT);
    });
  });
}
