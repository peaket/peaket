// 보상 실행기(CompensationRunner)와 claimDue의 단위 시험(BUILD_ORDER BAT-011, RV-04, P-T39 ③).
// 정본: docs/features/payment.md §3 '보상 세 걸음의 첫 구현', docs/adr/0354-prf-173-split-compensation-fence.md,
// specs/payment.qnt `compStart`·`compFence`·`compCancel`.
// 실행기는 STARTED 행을 발권 막기 → 결제 취소 차례로 돌리고, 일시 실패는 늘려 쉬기로 다시 보내며,
// 영구 실패는 FAILED와 SEV2 로그로 끝낸다. 임대를 잃었으면 아무것도 쓰지 않는다.
import { describe, expect, test } from 'vitest';
import {
  CompensationRunner,
  type CompensationCompleteWriteResult,
  type CompensationJobs,
  type CompensationLog,
  type CompensationSignals,
  type OrderCompensation,
  TicketFenceCallError,
  compensationRetryDelayMs,
} from '../src/modules/booking/index.js';

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-000000000401';

const rowOf = (over: Partial<OrderCompensation> = {}): OrderCompensation => ({
  orderId: ORDER,
  status: 'STARTED',
  reason: 'EVENT_CANCELLED',
  attempts: 0,
  startedAtMs: NOW - 1_000,
  updatedAtMs: NOW - 1_000,
  ...over,
});

class FakeJobs implements CompensationJobs {
  readonly rows = new Map<string, OrderCompensation>();
  readonly due: string[] = [];
  readonly fencedCalls: Array<{ orderId: string; nowMs: number; leaseUntilMs?: number }> = [];
  readonly compensatedCalls: Array<{ orderId: string; nowMs: number; leaseUntilMs?: number }> = [];
  readonly retryCalls: Array<{ orderId: string; code: string; nextAtMs: number; nowMs: number; leaseUntilMs?: number }> = [];
  readonly failedCalls: Array<{ orderId: string; code: string; nowMs: number; leaseUntilMs?: number }> = [];
  retryResult = true;

  constructor(rows: readonly OrderCompensation[] = []) {
    for (const row of rows) this.rows.set(row.orderId, row);
  }

  async candidates(): Promise<readonly string[]> {
    return [];
  }

  async start(): Promise<{ readonly status: 'CREATED' }> {
    return { status: 'CREATED' };
  }

  async claimDue(_limit: number, leaseMs: number, nowMs: number): Promise<readonly OrderCompensation[]> {
    return this.due.splice(0).map((orderId) => {
      const row = { ...this.rows.get(orderId)!, leaseUntilMs: nowMs + leaseMs };
      this.rows.set(orderId, row);
      return row;
    });
  }

  async get(orderId: string): Promise<OrderCompensation | undefined> {
    return this.rows.get(orderId);
  }

  async fenced(input: { readonly orderId: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean> {
    this.fencedCalls.push(input);
    const row = this.rows.get(input.orderId);
    if (!row || (input.leaseUntilMs !== undefined && row.leaseUntilMs !== input.leaseUntilMs)) return false;
    this.rows.set(input.orderId, { ...row, status: 'FENCED', fencedAtMs: input.nowMs, updatedAtMs: input.nowMs });
    return true;
  }

  async compensated(input: { readonly orderId: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<CompensationCompleteWriteResult> {
    this.compensatedCalls.push(input);
    const row = this.rows.get(input.orderId);
    if (!row || (input.leaseUntilMs !== undefined && row.leaseUntilMs !== input.leaseUntilMs)) return { status: 'LEASE_LOST' };
    this.rows.set(input.orderId, { ...row, status: 'COMPENSATED', compensatedAtMs: input.nowMs, updatedAtMs: input.nowMs });
    return { status: 'COMPENSATED' };
  }

  async retry(input: { readonly orderId: string; readonly code: string; readonly nextAtMs: number; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean> {
    this.retryCalls.push(input);
    return this.retryResult;
  }

  async failed(input: { readonly orderId: string; readonly code: string; readonly nowMs: number; readonly leaseUntilMs?: number }): Promise<boolean> {
    this.failedCalls.push(input);
    const row = this.rows.get(input.orderId);
    if (row) this.rows.set(input.orderId, { ...row, status: 'FAILED', lastError: input.code, updatedAtMs: input.nowMs });
    return true;
  }

  async release(): Promise<boolean> {
    return true;
  }

  async gauges(): Promise<{ readonly pending: number; readonly failed: number }> {
    return { pending: 0, failed: 0 };
  }
}

const logOf = () => {
  const failed: Array<{ orderId: string; stage: string; code: string }> = [];
  const runError: Array<{ stage: string; orderId?: string }> = [];
  const log: CompensationLog = {
    failed: (q) => void failed.push(q),
    entered: () => undefined,
    stale: () => undefined,
    runError: (q) => void runError.push({ stage: q.stage, ...(q.orderId === undefined ? {} : { orderId: q.orderId }) }),
  };
  return { log, failed, runError };
};

const signalsOf = () => {
  const results: string[] = [];
  const signals: CompensationSignals = { result: (r) => void results.push(r), jobs: () => undefined };
  return { signals, results };
};

const runnerOf = (jobs: FakeJobs, fenceRun: (orderId: string) => Promise<void>, cancelRun: (orderId: string) => Promise<void>) => {
  const { log, failed, runError } = logOf();
  const { signals, results } = signalsOf();
  const fenceCalls: string[] = [];
  const cancelCalls: string[] = [];
  const runner = new CompensationRunner({
    jobs,
    fence: { run: async ({ orderId }) => { fenceCalls.push(orderId); await fenceRun(orderId); return { blocked: true, alreadyEntered: 0 }; } },
    cancel: { run: async ({ orderId }) => { cancelCalls.push(orderId); await cancelRun(orderId); } },
    log,
    signals,
    clock: { now: () => NOW },
  });
  return { runner, fenceCalls, cancelCalls, failed, runError, results };
};

describe('보상 실행기 [RV-04] [P-T39 ③]', () => {
  test('P-T39 ③_RV-04_기한이_된_STARTED_행은_발권_막기_뒤_결제_취소로_COMPENSATED가_된다', async () => {
    const jobs = new FakeJobs([rowOf()]);
    jobs.due.push(ORDER);
    const { runner, fenceCalls, cancelCalls } = runnerOf(
      jobs,
      async (orderId) => void (await jobs.fenced({ orderId, nowMs: NOW, leaseUntilMs: jobs.rows.get(orderId)!.leaseUntilMs })),
      async (orderId) => void (await jobs.compensated({ orderId, nowMs: NOW, leaseUntilMs: jobs.rows.get(orderId)!.leaseUntilMs })),
    );
    const out = await runner.tick();
    expect(out).toMatchObject({ claimed: 1, compensated: 1, fenced: 0, retried: 0, failed: 0 });
    expect(fenceCalls).toEqual([ORDER]);
    expect(cancelCalls).toEqual([ORDER]);
    expect(jobs.rows.get(ORDER)?.status).toBe('COMPENSATED');
  });

  test('P-T39 ③_RV-04_일시_실패는_늘려_쉬기로_다시_보내고_결제_취소를_부르지_않는다', async () => {
    const jobs = new FakeJobs([rowOf()]);
    jobs.due.push(ORDER);
    const { runner, cancelCalls, results } = runnerOf(jobs, async () => { throw new TicketFenceCallError('UNAVAILABLE'); }, async () => undefined);
    const out = await runner.tick();
    expect(out).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    expect(cancelCalls).toEqual([]);
    expect(jobs.retryCalls).toHaveLength(1);
    expect(jobs.retryCalls[0]).toMatchObject({ orderId: ORDER, code: 'UNAVAILABLE', nextAtMs: NOW + compensationRetryDelayMs(1, 0.5) });
    expect(results).toEqual(['retry']);
    expect(jobs.rows.get(ORDER)?.status).toBe('STARTED');
  });

  test('P-T39 ③_RV-04_영구_실패는_FAILED와_SEV2_로그로_끝낸다', async () => {
    const jobs = new FakeJobs([rowOf()]);
    jobs.due.push(ORDER);
    const { runner, cancelCalls, failed, results } = runnerOf(jobs, async () => { throw new TicketFenceCallError('FAILED_PRECONDITION'); }, async () => undefined);
    const out = await runner.tick();
    expect(out).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
    expect(jobs.failedCalls).toHaveLength(1);
    expect(jobs.failedCalls[0]).toMatchObject({ orderId: ORDER, code: 'FAILED_PRECONDITION' });
    expect(jobs.rows.get(ORDER)?.status).toBe('FAILED');
    expect(failed).toEqual([{ orderId: ORDER, stage: 'fence', code: 'FAILED_PRECONDITION' }]);
    expect(results).toEqual(['failed']);
    expect(cancelCalls).toEqual([]);
  });

  test('P-T39 ③_RV-04_발권_막기가_FENCED를_쓰지_못하면_결제_취소를_부르지_않는다', async () => {
    const jobs = new FakeJobs([rowOf()]);
    jobs.due.push(ORDER);
    // fence 대역이 성공을 돌려줬지만 저장소의 FENCED 쓰기가 실패한 것과 같은 상태(행은 STARTED 그대로)를 만든다
    const { runner, cancelCalls } = runnerOf(jobs, async () => undefined, async () => undefined);
    const out = await runner.tick();
    expect(out).toMatchObject({ claimed: 1, compensated: 0, retried: 0, failed: 0 });
    expect(cancelCalls).toEqual([]);
    expect(jobs.rows.get(ORDER)?.status).toBe('STARTED');
  });

  test('P-T39 ③_RV-04_임대를_잃은_쓰기는_다시_보내기를_남기지_않는다', async () => {
    const jobs = new FakeJobs([rowOf({ status: 'FENCED', fencedAtMs: NOW - 1 })]);
    jobs.due.push(ORDER);
    jobs.retryResult = false;
    const { runner, results } = runnerOf(jobs, async () => undefined, async () => { throw new Error('LEASE_LOST'); });
    const out = await runner.tick();
    expect(out).toMatchObject({ claimed: 1, retried: 0, failed: 0, compensated: 0 });
    expect(jobs.retryCalls).toHaveLength(1);
    expect(results).toEqual([]);
    expect(jobs.rows.get(ORDER)?.status).toBe('FENCED');
  });
});
