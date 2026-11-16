// 입장 기록 대조와 환급 집기(BAT-420 GAT-090 A, P-T19 ①③, docs/features/transfer-refund.md §3.1 '입장 기록 대조와 환급 집기') 단위 시험.
// 환급 실행기가 마감 뒤 보류 취소(REQUESTED)를 결제사로 보내기 전에 ticket-svc 입장 기록을 보고, 기록이 있으면 환급하지 않고 이상 표시를 열며,
// 모르면(조회 실패·표 없음) 환급하지 않고 다음 틱에 다시 묻고, 없으면 조건부로 집은 뒤에만 결제사를 부르는지 본다.
// 저장소는 상태를 가진 대역이다(마감 시각 비교·조건부 갱신의 실제 SQL은 test-int/cancellation.int.test.ts가 본다). 시험 담당이 구현 전에 썼다(ADR-0270).
import { describe, expect, test } from 'vitest';
import { RefundAfterEntry, type EntryRecordView } from '../src/modules/refund/index.js';

const START = Date.parse('2026-11-20T19:00:00+09:00');
/** 마감 = 공연 시작 + 50시간(180,000,000ms) */
const DUE = START + 180_000_000;
const NOW = DUE + 60_000;
const ENTERED_AT = Date.parse('2026-11-20T18:01:00+09:00');

interface FakeRow {
  cancellationId: string;
  orderId: string;
  ticketId: string;
  amount: number;
  status: 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
  attempts: number;
  dueAtMs?: number;
  entryRecordedAtMs?: number;
  nextRetryAtMs?: number;
}

const requested = (id: string, amount = 3_334): FakeRow => ({ cancellationId: `c-${id}`, orderId: `o-${id}`, ticketId: `t-${id}`, amount, status: 'REQUESTED', attempts: 0, dueAtMs: DUE });
const pending = (id: string, attempts = 1, amount = 7_000): FakeRow => ({ cancellationId: `c-${id}`, orderId: `o-${id}`, ticketId: `t-${id}`, amount, status: 'REFUND_PENDING', attempts, nextRetryAtMs: NOW - 1 });

function fixture(rows: FakeRow[], o: { claim?: boolean } = {}) {
  const byId = new Map(rows.map((r) => [r.cancellationId, r]));
  const entryAnswers = new Map<string, EntryRecordView>();
  const behaviour = { lookupFails: false, claim: o.claim ?? true };
  const lookups: { ids: readonly string[]; deadlineMs: number }[] = [];
  const pays: { cancellationId: string; orderId: string; amount: number }[] = [];
  const claims: { cancellationId: string; nowMs: number }[] = [];
  const marks: { cancellationId: string; enteredAtMs: number; nowMs: number }[] = [];
  const flags: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const warns: { o: object; msg: string }[] = [];
  const errors: { o: object; msg: string }[] = [];
  const refund = new RefundAfterEntry({
    nowMs: () => NOW,
    writes: {
      dueRefunds: async (nowMs: number, limit: number) =>
        rows
          .filter(
            (r) =>
              (r.status === 'REQUESTED' && r.entryRecordedAtMs === undefined && r.dueAtMs !== undefined && r.dueAtMs <= nowMs) ||
              (r.status === 'REFUND_PENDING' && (r.nextRetryAtMs === undefined || r.nextRetryAtMs <= nowMs)),
          )
          .slice(0, limit)
          .map((r) => ({ cancellationId: r.cancellationId, orderId: r.orderId, ticketId: r.ticketId, amount: r.amount, reason: 'USER', status: r.status, attempts: r.attempts })),
      updateStatus: async (q: { cancellationId: string; status: FakeRow['status'] }) => {
        writes.push(`status:${q.cancellationId}:${q.status}`);
        byId.get(q.cancellationId)!.status = q.status;
      },
      scheduleRefundRetry: async (q: { cancellationId: string }) => void writes.push(`retry:${q.cancellationId}`),
      markRefundFailed: async (q: { cancellationId: string }) => void writes.push(`failed:${q.cancellationId}`),
    } as never,
    payments: {
      cancel: async (q) => {
        pays.push({ cancellationId: q.cancellationId, orderId: q.orderId, amount: q.amount });
        return 'CANCELLED';
      },
    },
    entries: {
      lookup: async (ids, deadlineMs) => {
        lookups.push({ ids: [...ids], deadlineMs });
        if (behaviour.lookupFails) throw new Error('ticket-svc 14 UNAVAILABLE');
        return new Map(ids.map((id) => [id, entryAnswers.get(id) ?? { found: true, entered: false }]));
      },
    },
    claims: {
      claimDue: async (cancellationId, nowMs) => {
        claims.push({ cancellationId, nowMs });
        const r = byId.get(cancellationId)!;
        if (!behaviour.claim || r.status !== 'REQUESTED' || r.entryRecordedAtMs !== undefined) return false;
        r.status = 'REFUND_PENDING';
        return true;
      },
      markEntryRecorded: async (cancellationId, enteredAtMs, nowMs) => {
        marks.push({ cancellationId, enteredAtMs, nowMs });
        const r = byId.get(cancellationId)!;
        r.entryRecordedAtMs = enteredAtMs;
        delete r.dueAtMs;
        return true;
      },
    },
    flags: { open: async (q) => void flags.push({ ...q }) },
    log: { warn: (o, msg) => void warns.push({ o, msg }), error: (o, msg) => void errors.push({ o, msg }) },
  });
  return { refund, rows: byId, entryAnswers, behaviour, lookups, pays, claims, marks, flags, writes, warns, errors };
}

describe('입장 기록 대조와 환급 집기 [BAT-420 GAT-090 A]', () => {
  test('P-T19 ① 들어감·통과 기록이 있으면 결제사를 부르지 않고 가장 이른 입장 시각을 남겨 이상 표시를 한 번 연다(단위)', async () => {
    const f = fixture([requested('a')]);
    f.entryAnswers.set('t-a', { found: true, entered: true, firstEnteredAtMs: ENTERED_AT });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 0, entryRecorded: 1, unverified: 0, held: 0 });
    expect(f.pays).toEqual([]);
    expect(f.claims).toEqual([]);
    expect(f.marks).toEqual([{ cancellationId: 'c-a', enteredAtMs: ENTERED_AT, nowMs: NOW }]);
    expect(f.flags).toEqual([{ cancellationId: 'c-a', orderId: 'o-a', ticketId: 't-a', enteredAtMs: ENTERED_AT, nowMs: NOW }]);
    expect(f.writes).toEqual([]);
    expect(f.rows.get('c-a')!.status).toBe('REQUESTED');
  });

  test('P-T19 ③ 입장 기록이 없으면 조건부로 집은 뒤에만 결제사를 한 번 불러 환급한다(단위)', async () => {
    const f = fixture([requested('a')]);
    await expect(f.refund.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.claims).toEqual([{ cancellationId: 'c-a', nowMs: NOW }]);
    expect(f.pays).toEqual([{ cancellationId: 'c-a', orderId: 'o-a', amount: 3_334 }]);
    expect(f.writes).toEqual(['status:c-a:REFUNDED']);
    expect(f.flags).toEqual([]);
    expect(f.marks).toEqual([]);
  });

  test('GAT-090 A1 입장 조회는 한 틱에 한 번, 보류 취소(REQUESTED)의 표만 요청 차례로 묻고 데드라인은 2,000ms다', async () => {
    const f = fixture([requested('a'), pending('p'), requested('b')]);
    await f.refund.run();
    expect(f.lookups).toEqual([{ ids: ['t-a', 't-b'], deadlineMs: 2_000 }]);
    // 재시도 중인 REFUND_PENDING은 입장을 묻지 않고 지금처럼 결제사를 부른다
    expect(f.pays.map((p) => p.cancellationId).sort()).toEqual(['c-a', 'c-b', 'c-p']);
    expect(f.claims.map((c) => c.cancellationId)).toEqual(['c-a', 'c-b']);
  });

  test('GAT-090 A1 입장 조회가 실패하면 보류 취소를 환급하지 않고 재시도 횟수·환급 시각을 그대로 두며 다음 틱에 다시 묻는다(실패 뒤 성공)', async () => {
    const f = fixture([requested('a'), requested('b'), pending('p')]);
    f.behaviour.lookupFails = true;
    await expect(f.refund.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 2, held: 0 });
    expect(f.pays.map((p) => p.cancellationId)).toEqual(['c-p']);
    expect(f.claims).toEqual([]);
    expect(f.marks).toEqual([]);
    expect(f.flags).toEqual([]);
    expect(f.writes).toEqual(['status:c-p:REFUNDED']);
    for (const id of ['c-a', 'c-b']) expect(f.rows.get(id)).toMatchObject({ status: 'REQUESTED', attempts: 0, dueAtMs: DUE });
    expect(JSON.stringify(f.warns)).toContain('cancellation-entry-lookup-failed');
    expect(f.errors).toEqual([]);

    f.behaviour.lookupFails = false;
    await expect(f.refund.run()).resolves.toEqual({ refunded: 2, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.lookups).toHaveLength(2);
    expect(f.pays.map((p) => p.cancellationId)).toEqual(['c-p', 'c-a', 'c-b']);
  });

  test('GAT-090 A1 ticket-svc가 표를 모르면(found 거짓) 그 행만 환급하지 않고 경고를 남긴다(있음·없음·모름의 가운데 값)', async () => {
    const f = fixture([requested('unknown'), requested('known')]);
    f.entryAnswers.set('t-unknown', { found: false, entered: false });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 1, held: 0 });
    expect(f.pays.map((p) => p.cancellationId)).toEqual(['c-known']);
    expect(f.claims.map((c) => c.cancellationId)).toEqual(['c-known']);
    expect(f.rows.get('c-unknown')).toMatchObject({ status: 'REQUESTED', attempts: 0, dueAtMs: DUE });
    expect(f.marks).toEqual([]);
    expect(JSON.stringify(f.warns)).toContain('cancellation-entry-ticket-unknown');
    expect(JSON.stringify(f.warns)).toContain('c-unknown');
  });

  test('GAT-090 A2 집기가 거짓이면(다른 실행기가 먼저 집음) 그 행의 결제사를 부르지 않는다(단위)', async () => {
    const f = fixture([requested('a')], { claim: false });
    await f.refund.run();
    expect(f.claims).toHaveLength(1);
    expect(f.pays).toEqual([]);
    expect(f.writes).toEqual([]);
  });
});
