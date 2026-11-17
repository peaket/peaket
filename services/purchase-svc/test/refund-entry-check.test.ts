// 입장 기록 대조와 환급 집기(BAT-420 GAT-090 A, P-T19 ①③, docs/features/transfer-refund.md §3.1 '입장 기록 대조와 환급 집기') 단위 시험.
// 환급 실행기가 마감 뒤 보류 취소(REQUESTED)를 결제사로 보내기 전에 ticket-svc 입장 기록을 보고, 기록이 있으면 환급하지 않고 이상 표시를 열며,
// 모르면(조회 실패·표 없음) 환급하지 않고 다음 틱에 다시 묻고, 없으면 조건부로 집은 뒤에만 결제사를 부르는지 본다.
// 저장소는 상태를 가진 대역이다(마감 시각 비교·조건부 갱신의 실제 SQL은 test-int/cancellation.int.test.ts가 본다). 시험 담당이 구현 전에 썼다(ADR-0270).
import { describe, expect, test } from 'vitest';
import { CsCaseRejected, RefundAfterEntry, type EntryRecordView } from '../src/modules/refund/index.js';

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

function fixture(rows: FakeRow[], o: { claim?: boolean; mark?: boolean } = {}) {
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
        // mark 거짓: 다른 실행기가 같은 행에 먼저 입장 기록을 남겨 이 쓰기는 0행이다
        if (o.mark === false) return false;
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

// ---- BAT-420 리뷰 D1(시험 담당, 구현 전에 씀, 계획 §11 보충 3, transfer-refund §3.1 ⑤): REFUNDED 쓰기가 0행이면 그 행을 다시 읽는다 ----
describe('결제사 환급 뒤 0행 쓰기의 다시 읽기 [BAT-420 리뷰 D1]', () => {
  type State = 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
  /** 실행기가 집은 행 하나. 결제사는 CANCELLED, REFUNDED 쓰기는 0행(다른 길이 먼저 끝냈거나 무효가 됐다), 다시 읽으면 reread 상태 */
  const run0 = async (o: { status: 'REQUESTED' | 'REFUND_PENDING'; reread: State | undefined }) => {
    const lines: { level: 'warn' | 'error'; o: object; msg: string }[] = [];
    const finds: string[] = [];
    const pays: string[] = [];
    const runner = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: {
        dueRefunds: async () => [{ cancellationId: 'c-1', orderId: 'o-1', ticketId: 't-1', amount: 7_000, reason: 'USER', status: o.status, attempts: o.status === 'REQUESTED' ? 0 : 1 }],
        updateStatus: async () => false,
        scheduleRefundRetry: async () => true,
        markRefundFailed: async () => true,
      } as never,
      payments: { cancel: async (q) => (pays.push(q.cancellationId), 'CANCELLED') },
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      orders: {
        findCancellation: async (id: string) => {
          finds.push(id);
          return o.reread === undefined ? undefined : { cancellationId: id, orderId: 'o-1', ticketId: 't-1', refundAmount: 7_000, state: o.reread, refundAttempts: 1 };
        },
      },
      log: { warn: (x, msg) => void lines.push({ level: 'warn', o: x, msg }), error: (x, msg) => void lines.push({ level: 'error', o: x, msg }) },
    });
    const result = await runner.run();
    const named = (name: string, level?: 'warn' | 'error') => lines.filter((l) => (level === undefined || l.level === level) && JSON.stringify(l).includes(name));
    return { result, lines, named, finds, pays };
  };

  test.each(['REFUND_PENDING', 'REQUESTED'] as const)('GAT-090 R1 다른 길이 먼저 REFUNDED로 끝낸 행(%s로 집음)은 SEV1 없이 환급으로 센다', async (status) => {
    const r = await run0({ status, reread: 'REFUNDED' });
    expect(r.pays).toEqual(['c-1']);
    expect(r.finds).toEqual(['c-1']);
    expect(r.result).toMatchObject({ refunded: 1, pending: 0, failed: 0 });
    expect(r.named('cancellation-refunded-after-void')).toEqual([]);
    expect(r.named('cancellation-refund-state-unexpected')).toEqual([]);
  });

  test('GAT-090 R1 다시 읽어 VOIDED면(무효 뒤 환급) SEV1 cancellation-refunded-after-void가 그 취소 ID로 한 번이고 환급으로 세지 않는다', async () => {
    const r = await run0({ status: 'REFUND_PENDING', reread: 'VOIDED' });
    const sev1 = r.named('cancellation-refunded-after-void', 'error');
    expect(sev1).toHaveLength(1);
    expect(JSON.stringify(sev1[0])).toContain('c-1');
    expect(r.result).toMatchObject({ refunded: 0 });
  });

  test.each([['REQUESTED'], ['REFUND_PENDING'], [undefined]] as const)('GAT-090 R1 다시 읽어 %s(그 밖)이면 SEV1이 아니라 경고 cancellation-refund-state-unexpected 한 번이고 환급으로 세지 않는다', async (reread) => {
    const r = await run0({ status: 'REFUND_PENDING', reread });
    expect(r.named('cancellation-refunded-after-void')).toEqual([]);
    const warned = r.named('cancellation-refund-state-unexpected', 'warn');
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain('c-1');
    expect(r.result).toMatchObject({ refunded: 0 });
  });
});

// ---- 검증(e2d565c6) 살아남은 변이(시험 담당 l3w8-420-fix-test, 2026-11-17): 결과 수·0행 쓰기·100장 나눔·조립 검사 ----
describe('환급 실행기의 0행 쓰기·나눔·조립 [BAT-420 검증 살아남은 것]', () => {
  test('P-T19 ① 입장 기록 남기기가 0행이면(다른 실행기가 먼저 남김) 이상 표시를 열지 않고 entryRecorded로 세지 않으며 결제사도 부르지 않는다', async () => {
    const f = fixture([requested('a')], { mark: false });
    f.entryAnswers.set('t-a', { found: true, entered: true, firstEnteredAtMs: ENTERED_AT });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.marks).toHaveLength(1);
    expect(f.flags).toEqual([]);
    expect(f.pays).toEqual([]);
    expect(f.claims).toEqual([]);
  });

  test('GAT-090 A1 보류 취소가 101장이면 입장 조회를 100장·1장 두 번으로 나눠 요청 차례대로 묻는다(ticket.proto GetEntryRecords 100장)', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => requested(String(i).padStart(3, '0')));
    const f = fixture(rows);
    await f.refund.run(200);
    expect(f.lookups.map((l) => l.ids.length)).toEqual([100, 1]);
    expect(f.lookups.flatMap((l) => l.ids)).toEqual(rows.map((r) => r.ticketId));
    for (const l of f.lookups) expect(l.deadlineMs).toBe(2_000);
    expect(f.pays).toHaveLength(101);
  });

  /** REFUND_PENDING 행 하나를 결제사 답 outcome으로 돌린다. 상태 쓰기(실패 표시·재시도 예약)는 applied가 거짓이면 0행(그사이 CS가 무효로 끝냄) */
  const runPending = async (outcome: 'REJECTED' | 'UNKNOWN', applied: boolean) => {
    const failedMarks: string[] = [];
    const retries: string[] = [];
    const notices: string[] = [];
    const runner = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: {
        dueRefunds: async () => [{ cancellationId: 'c-p', orderId: 'o-p', ticketId: 't-p', amount: 7_000, reason: 'USER', status: 'REFUND_PENDING', attempts: 1 }],
        updateStatus: async () => true,
        scheduleRefundRetry: async (q: { cancellationId: string }) => (retries.push(q.cancellationId), applied),
        markRefundFailed: async (q: { cancellationId: string }) => (failedMarks.push(q.cancellationId), applied),
      } as never,
      payments: { cancel: async () => outcome },
      entries: { lookup: async () => new Map() },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      failureNotice: { open: async (q) => void notices.push(q.cancellationId) },
    });
    return { result: await runner.run(), failedMarks, retries, notices };
  };

  test('GAT-090 A3 결제사 거절 뒤 실패 표시가 0행이면(CS가 무효로 끝냄) CS 환급 실패 건을 열지 않고 failed로 세지 않는다(1행이면 한 번 연다)', async () => {
    const voided = await runPending('REJECTED', false);
    expect(voided.failedMarks).toEqual(['c-p']);
    expect(voided.notices).toEqual([]);
    expect(voided.result).toMatchObject({ refunded: 0, pending: 0, failed: 0 });
    const marked = await runPending('REJECTED', true);
    expect(marked.notices).toEqual(['c-p']);
    expect(marked.result).toMatchObject({ failed: 1 });
  });

  test('GAT-090 A3 결과 모름 뒤 재시도 예약이 0행이면(CS가 무효로 끝냄) pending으로 세지 않는다(1행이면 하나)', async () => {
    const voided = await runPending('UNKNOWN', false);
    expect(voided.retries).toEqual(['c-p']);
    expect(voided.result).toMatchObject({ refunded: 0, pending: 0, failed: 0 });
    expect(voided.notices).toEqual([]);
    expect((await runPending('UNKNOWN', true)).result).toMatchObject({ pending: 1 });
  });

  test('GAT-090 A6 입장 기록 대조(entries)나 조건부 집기(claims) 없이 환급 실행기를 만들면 던진다', () => {
    const base = { nowMs: () => NOW, writes: {} as never, payments: { cancel: async () => 'CANCELLED' as const } };
    const entries = { lookup: async () => new Map<string, EntryRecordView>() };
    const claims = { claimDue: async () => true, markEntryRecorded: async () => true };
    expect(() => new RefundAfterEntry({ ...base, claims })).toThrow(/entries/);
    expect(() => new RefundAfterEntry({ ...base, entries })).toThrow(/claims/);
    expect(() => new RefundAfterEntry({ ...base })).toThrow();
    expect(() => new RefundAfterEntry({ ...base, entries, claims })).not.toThrow();
  });
});

// ---- BAT-420 다시 보기 2 N1·N2(시험 담당 l3w8-420-n-test, 구현 전에 씀, 계획 §11 보충 5, transfer-refund §3.1 ⑥) ----
// 마감 뒤 환급 실행기도 CS 건(환급 실패 → 이상 표시 차례)을 처리 중에는 부르지 않고 틱 끝에서 5초 [가정] 예산 안에만 연다. 시계는 가짜다.
describe('마감 뒤 환급 실행기의 CS 건 다시 열기 [BAT-420 다시 보기 2 N1·N2]', () => {
  type Clock = { t: number };
  type Ops = 'hang' | 202 | 500 | { readonly slowMs: number };
  type Due = { cancellationId: string; orderId: string; ticketId: string; amount: number; reason: string; status: 'REQUESTED' | 'REFUND_PENDING'; attempts: number };
  const due = (id: string, status: Due['status'], attempts = 0): Due => ({ cancellationId: `c-${id}`, orderId: `o-${id}`, ticketId: `t-${id}`, amount: 3_334, reason: 'USER', status, attempts });

  /** 환급 실패 표시(refund_failed_at)·이상 표시(entry_recorded_at)를 가진 상태 대역과 ops 대역. 차례 기록에 일과 ops 호출을 남긴다 */
  function rig(clock: Clock, o: { refundFailures?: number; flags?: number; due?: Due[]; pay?: (id: string) => 'CANCELLED' | 'REJECTED' | 'UNKNOWN' }) {
    const log: string[] = [];
    const ops = { mode: 'hang' as Ops };
    const call = async (label: string): Promise<void> => {
      log.push(`ops:${label}`);
      const a = ops.mode;
      if (a === 'hang') {
        clock.t += 5_000;
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      if (typeof a === 'object') {
        clock.t += a.slowMs;
        return;
      }
      if (a !== 202) throw new CsCaseRejected('refund-failed', a);
    };
    const failed = new Map<string, { cancellationId: string; orderId: string; attempts: number; lastError: string }>();
    for (let i = 0; i < (o.refundFailures ?? 0); i++) failed.set(`rf-${i}`, { cancellationId: `rf-${i}`, orderId: `o-rf-${i}`, attempts: 5, lastError: 'REJECTED' });
    const refundOpened = new Map<string, number>();
    const flagRows = Array.from({ length: o.flags ?? 0 }, (_, i) => ({ cancellationId: `fl-${i}`, orderId: `o-fl-${i}`, ticketId: `t-fl-${i}`, enteredAtMs: ENTERED_AT }));
    const flagOpened = new Map<string, number>();
    const metric: string[] = [];
    const cuts: string[] = [];
    const warns: { o: object; msg: string }[] = [];
    const queue = [...(o.due ?? [])];
    const runner = new RefundAfterEntry({
      nowMs: () => clock.t,
      writes: {
        dueRefunds: async () => queue.splice(0),
        updateStatus: async (q: { cancellationId: string; status: string }) => (log.push(`write:${q.cancellationId}:${q.status}`), true),
        scheduleRefundRetry: async (q: { cancellationId: string }) => (log.push(`retry:${q.cancellationId}`), true),
        markRefundFailed: async (q: { cancellationId: string; attempts: number; lastError: string }) => {
          log.push(`failed:${q.cancellationId}`);
          failed.set(q.cancellationId, { cancellationId: q.cancellationId, orderId: `o-${q.cancellationId}`, attempts: q.attempts, lastError: q.lastError });
          return true;
        },
      } as never,
      payments: { cancel: async (q) => (log.push(`pay:${q.cancellationId}`), o.pay?.(q.cancellationId) ?? 'CANCELLED') },
      entries: {
        lookup: async (ids) => (log.push('lookup'), new Map(ids.map((id) => [id, id === 't-ent' ? { found: true, entered: true, firstEnteredAtMs: ENTERED_AT } : { found: true, entered: false }]))),
      },
      claims: { claimDue: async (id) => (log.push(`claim:${id}`), true), markEntryRecorded: async (id) => (log.push(`entry:${id}`), true) },
      failureNotice: { open: (q) => call(`fail:${q.cancellationId}`) },
      flags: { open: (q) => call(`flag:${q.cancellationId}`) },
      csOutbox: {
        pendingRefundFailures: async (limit) => [...failed.values()].filter((r) => !refundOpened.has(r.cancellationId)).slice(0, limit),
        markRefundFailureOpened: async (id, nowMs) => void refundOpened.set(id, nowMs),
        pendingFlags: async (limit) => flagRows.filter((r) => !flagOpened.has(r.cancellationId)).slice(0, limit),
        markFlagOpened: async (id, nowMs) => void flagOpened.set(id, nowMs),
      },
      csCaseOpenFailures: { inc: (kind) => void metric.push(kind), cut: (reason) => void cuts.push(reason) },
      log: { warn: (x, msg) => void warns.push({ o: x, msg }), error: () => undefined },
    });
    const opsCalls = () => log.filter((l) => l.startsWith('ops:'));
    const named = (name: string) => warns.filter((w) => JSON.stringify(w).includes(name));
    return { runner, log, ops, failed, refundOpened, flagOpened, metric, cuts, warns, opsCalls, named };
  }

  test('GAT-090 N1 마감 뒤 환급 실행기도 다시 열기를 틱 끝에서 예산 안에만 한다', async () => {
    const clock: Clock = { t: NOW };
    // 이번 틱의 일: 입장 기록 없는 보류 취소(집고 환급), 입장 기록 있는 보류 취소(새 이상 표시), 결제사 거절(새 환급 실패)
    const r = rig(clock, { refundFailures: 20, flags: 20, due: [due('new', 'REQUESTED'), due('ent', 'REQUESTED'), due('rej', 'REFUND_PENDING')], pay: (id) => (id === 'c-rej' ? 'REJECTED' : 'CANCELLED') });
    const before = clock.t;
    await expect(r.runner.run()).resolves.toMatchObject({ refunded: 1, failed: 1, entryRecorded: 1 });
    // 장애 주입이 끼어들었는지 먼저: ops를 불렀고 가짜 시간이 밀렸다
    expect(r.opsCalls()).toHaveLength(2);
    expect(clock.t - before).toBeGreaterThan(0);
    // 입장 기록 대조·집기·결제사·상태 쓰기가 모두 첫 ops 호출보다 앞이다(이번 틱에 새로 남긴 입장 기록·환급 실패도 처리 중에는 부르지 않는다)
    const lastWork = r.log.reduce((at, l, i) => (/^(lookup|claim:|pay:|write:|failed:|entry:|retry:)/.test(l) ? i : at), -1);
    const firstOps = r.log.findIndex((l) => l.startsWith('ops:'));
    expect(r.log.filter((l) => l.startsWith('pay:'))).toEqual(['pay:c-new', 'pay:c-rej']);
    expect(firstOps).toBeGreaterThan(lastWork);
    // 차례는 환급 실패 → 이상 표시라 멈추기 전 둘은 환급 실패 건이다
    expect(r.opsCalls()).toEqual(['ops:fail:rf-0', 'ops:fail:rf-1']);
    expect(r.cuts).toEqual(['unreachable']);
    expect(r.named('cs-case-reopen-cut')).toHaveLength(1);
    expect(clock.t - before).toBeLessThanOrEqual(10_000);
    expect(r.metric).toEqual(['REFUND_FAILED', 'REFUND_FAILED']);
    expect(r.refundOpened.size + r.flagOpened.size).toBe(0);

    // 느린 ops(4초)면 한 틱 2건
    const c2: Clock = { t: NOW };
    const slow = rig(c2, { refundFailures: 20, flags: 20 });
    slow.ops.mode = { slowMs: 4_000 };
    await slow.runner.run();
    expect(slow.refundOpened.size + slow.flagOpened.size).toBe(2);
    expect(slow.cuts).toEqual(['budget']);
  });

  test('GAT-090 N2 마감 뒤 환급 실행기는 환급 실패 건을 2xx로 받은 행만 연 것으로 적고 다음 틱에 다시 연다', async () => {
    const clock: Clock = { t: NOW };
    // 결제사 거절(첫 시도)과 결과 모름 5회 소진(앞 시도 4번) → 둘 다 refund_failed_at
    const r = rig(clock, { due: [due('rej', 'REFUND_PENDING', 0), due('max', 'REFUND_PENDING', 4)], pay: (id) => (id === 'c-rej' ? 'REJECTED' : 'UNKNOWN') });
    r.ops.mode = 500;
    await expect(r.runner.run()).resolves.toMatchObject({ failed: 2 });
    expect(r.log.filter((l) => l.startsWith('failed:'))).toEqual(['failed:c-rej', 'failed:c-max']);
    // 틱 끝 ops 500: 연 시각 빔·경고·지표 하나씩, run은 던지지 않는다
    expect(r.opsCalls()).toEqual(['ops:fail:c-rej', 'ops:fail:c-max']);
    expect(r.refundOpened.size).toBe(0);
    expect(r.named('cancellation-refund-failure-notice-failed')).toHaveLength(2);
    expect(r.metric).toEqual(['REFUND_FAILED', 'REFUND_FAILED']);
    // 다음 틱 202: 연 시각
    r.ops.mode = 202;
    clock.t += 60_000;
    await expect(r.runner.run()).resolves.toMatchObject({ failed: 0 });
    expect(r.refundOpened.get('c-rej')).toBe(NOW + 60_000);
    expect(r.refundOpened.get('c-max')).toBe(NOW + 60_000);
    // 그다음 틱: 다시 부르지 않는다
    const calls = r.opsCalls().length;
    await r.runner.run();
    expect(r.opsCalls()).toHaveLength(calls);
  });
});
