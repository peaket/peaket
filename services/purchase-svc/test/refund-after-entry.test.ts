// 환급 실행기(GAT-080·GAT-090): 입장 기록 마감 뒤 REQUESTED와 재시도할 REFUND_PENDING을 결제사 취소로 이어 간다.
// BAT-420(2026-11-16, 시험 담당): 정본(transfer-refund §3.1 '입장 기록 대조와 환급 집기')이 바뀌어 REQUESTED는 입장 기록 대조(입장 없음)와
// 조건부 집기를 거친 뒤에만 결제사를 부른다. 그래서 이 파일의 대역에 입장 조회(모두 입장 없음)·집기(늘 집음)를 꽂고, 결과에 entryRecorded·unverified를 더했다.
// 입장 기록이 나온 경우·조회 실패·집기 경합은 test/refund-entry-check.test.ts가 본다.
import { describe, expect, test } from 'vitest';
import { REFUND_RETRY_MAX_ATTEMPTS, RefundAfterEntry, refundRetryDelayMs } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-21T00:00:00Z');

interface Row {
  cancellationId: string;
  orderId: string;
  ticketId: string;
  amount: number;
  reason: 'USER';
  status: 'REQUESTED' | 'REFUND_PENDING';
  attempts: number;
  /** 같은 취소 ID의 계좌 다시 받기 시도 번호(BAT-425). 없으면 0 */
  refundAttempt?: number;
}

function fixture(rows: Row[], outcomes: Record<string, 'CANCELLED' | 'PENDING' | 'UNKNOWN' | 'REJECTED'>) {
  const updates: { cancellationId: string; status: string }[] = [];
  const retries: { cancellationId: string; attempts: number; nextRetryAtMs: number; lastError: string }[] = [];
  const failures: { cancellationId: string; attempts: number; lastError: string }[] = [];
  const notices: { cancellationId: string; attempts: number; lastError: string }[] = [];
  const calls: { cancellationId: string; amount: number; refundAttempt?: number }[] = [];
  const accountMarks: { cancellationId: string }[] = [];
  const refund = new RefundAfterEntry({
    nowMs: () => NOW,
    writes: {
      dueRefunds: async () => rows,
      updateStatus: async (q: { cancellationId: string; status: string }) => void updates.push({ cancellationId: q.cancellationId, status: q.status }),
      scheduleRefundRetry: async (q: { cancellationId: string; attempts: number; nextRetryAtMs: number; lastError: string }) => void retries.push(q),
      markRefundFailed: async (q: { cancellationId: string; attempts: number; lastError: string }) => void failures.push(q),
      markRefundAccountRequired: async (q: { cancellationId: string }) => void accountMarks.push({ cancellationId: q.cancellationId }),
    } as never,
    payments: {
      cancel: async (q) => {
        calls.push({ cancellationId: q.cancellationId, amount: q.amount, ...(q.refundAttempt ? { refundAttempt: q.refundAttempt } : {}) });
        return outcomes[q.cancellationId]!;
      },
    },
    failureNotice: { open: async (q: { cancellationId: string; attempts: number; lastError: string }) => void notices.push(q) },
    entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
    claims: { claimDue: async () => true, markEntryRecorded: async () => true },
  });
  return { refund, updates, retries, failures, notices, calls, accountMarks };
}

const row = (id: string, status: Row['status'], attempts = 0, amount = 10_000): Row => ({ cancellationId: id, orderId: `o-${id}`, ticketId: `t-${id}`, amount, reason: 'USER', status, attempts });

describe('환급 실행기', () => {
  test('GAT080_환급시각이_지난_REQUESTED를_결제사취소하고_모름은_다음재시도를_적는다', async () => {
    const f = fixture([row('c1', 'REQUESTED'), row('c2', 'REQUESTED', 0, 20_000)], { c1: 'CANCELLED', c2: 'UNKNOWN' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 1, pending: 1, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.calls).toEqual([
      { cancellationId: 'c1', amount: 10_000 },
      { cancellationId: 'c2', amount: 20_000 },
    ]);
    expect(f.updates).toEqual([{ cancellationId: 'c1', status: 'REFUNDED' }]);
    expect(f.retries[0]).toMatchObject({ cancellationId: 'c2', attempts: 1, nextRetryAtMs: NOW + refundRetryDelayMs(1), lastError: 'UNKNOWN' });
    expect(f.failures).toHaveLength(0);
  });

  test('GAT090_REFUND_PENDING은_재시도하고_시도횟수에_맞는_간격으로_미룬다', async () => {
    const f = fixture([row('c1', 'REFUND_PENDING', 2)], { c1: 'PENDING' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 1, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.retries[0]).toMatchObject({ cancellationId: 'c1', attempts: 3, nextRetryAtMs: NOW + refundRetryDelayMs(3), lastError: 'PENDING' });
  });

  // RV-21(높음): 계좌를 실은 시도 a1이 결과 모름으로 남은 뒤의 재시도는 계좌를 싣지 않지만, 같은 시도 번호(1)를 실어
  // payment-svc가 그 시도의 행을 조회로 정산하게 해야 한다. PENDING·UNKNOWN은 계좌 대기(REFUND_ACCOUNT_REQUIRED)가 아니므로
  // refund_account_required_at을 쓰지 않고 다음 재시도를 예약한다(ADR-0316 결정 4).
  test('R-T42 ④_RV21_계좌_시도(1)의_재시도는_같은_시도_번호로_보내고_계좌_대기로_멈추지_않는다', async () => {
    for (const outcome of ['PENDING', 'UNKNOWN'] as const) {
      const f = fixture([{ ...row('c1', 'REFUND_PENDING', 0), refundAttempt: 1 }], { c1: outcome });
      await expect(f.refund.run(), outcome).resolves.toEqual({ refunded: 0, pending: 1, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });
      expect(f.calls, outcome).toEqual([{ cancellationId: 'c1', amount: 10_000, refundAttempt: 1 }]);
      expect(f.retries[0], outcome).toMatchObject({ cancellationId: 'c1', attempts: 1, lastError: outcome });
      expect(f.accountMarks, outcome).toEqual([]);
      expect(f.failures, outcome).toEqual([]);
    }
  });

  test('GAT090_업무거절은_바로_CS처리함_대상으로_남긴다', async () => {
    const f = fixture([row('c1', 'REFUND_PENDING', 1)], { c1: 'REJECTED' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 1, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.failures[0]).toMatchObject({ cancellationId: 'c1', attempts: 2, lastError: 'REJECTED' });
    expect(f.notices[0]).toMatchObject({ cancellationId: 'c1', attempts: 2, lastError: 'REJECTED' });
    expect(f.retries).toHaveLength(0);
  });

  test('GAT090_재시도_상한을_넘으면_CS처리함_대상으로_남긴다', async () => {
    const f = fixture([row('c1', 'REFUND_PENDING', REFUND_RETRY_MAX_ATTEMPTS - 1)], { c1: 'UNKNOWN' });
    await expect(f.refund.run()).resolves.toEqual({ refunded: 0, pending: 0, failed: 1, entryRecorded: 0, unverified: 0, held: 0 });
    expect(f.failures[0]).toMatchObject({ cancellationId: 'c1', attempts: REFUND_RETRY_MAX_ATTEMPTS, lastError: 'UNKNOWN' });
    expect(f.notices).toHaveLength(1);
  });

  test('GAT090_재시도_간격은_1분에서_6시간까지_늘고_상한을_넘어도_마지막_간격이다', () => {
    expect([1, 2, 3, 4, 5].map(refundRetryDelayMs)).toEqual([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
    expect(refundRetryDelayMs(9)).toBe(6 * 60 * 60_000);
    expect(() => refundRetryDelayMs(0)).toThrow(RangeError);
  });
});
