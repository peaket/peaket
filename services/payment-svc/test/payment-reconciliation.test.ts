// 대사 실행기(BUILD_ORDER HOT-153, docs/features/payment.md §8 '대사의 첫 구현', P-T32). 저장소·결제사·시계를 대역으로 둔다. 실제 저장소·시뮬레이터는 test-int가 본다.
import { fakeClock, type FakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PaymentReconciliation } from '../src/modules/payment/application/payment-reconciliation.js';
import type { ListTransactionsResult, PaymentGatewayPort, PgName, PgTransaction, QueryOptions, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import type { OnSaleCalendar, PaymentGateways, PaymentReconciliationLog, PaymentReconciliationSignals, PaymentReconciliationStore, ReconCompareRow, ReconDiffInput, ReconLedgerRow, ReconRun, ReconSeenInput } from '../src/modules/payment/domain/ports.js';
import { RECON_PAGE_RETRIES, RECON_PULL_BATCH, RECON_PULL_PAUSE_MS, RECON_SEV1_LIMIT, RECON_THROTTLE_BACKOFF_MS, ReconRunLostError, type ReconLedger, type ReconRunRef } from '../src/modules/payment/domain/reconciliation.js';

const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const NOW = KST('2026-11-10T00:10:00');
const AT = KST('2026-11-09T12:00:00');
const ORDER = (n: number) => `0195f3a0-0000-7000-8000-00000000000${n}`;

const tx = (ref: string, n: number, status: PgTransaction['status'] = 'APPROVED', amount = 1000): PgTransaction => ({ paymentRef: ref, orderRef: ORDER(n), status, amount, atMs: AT });
const ledger = (ref: string, n: number, status: ReconLedger['status'] = 'APPROVED', o: Partial<ReconLedger> = {}): ReconLedger => ({ paymentId: `p-${n}`, orderId: ORDER(n), eventId: `e-${n}`, attemptNo: 1, pg: 'TOSS', paymentRef: ref, amount: 1000, status, ...o });
const found = (ref: string, n: number, status: Extract<QueryResult, { kind: 'FOUND' }>['status'], amount = 1000): QueryResult => ({ kind: 'FOUND', paymentRef: ref, orderRef: ORDER(n), status, amount, balanceAmount: status === 'CANCELED' ? 0 : amount });
/** 앞 엿새는 끝난 날로 둔다(전날 하나만 돌게, 리뷰 고침 H4의 시험은 이 값을 덮는다) */
const EARLIER_DONE: ReconRunRef[] = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((date) => ({ date, status: 'DONE' }));

class FakeStore implements PaymentReconciliationStore {
  runs = new Map<string, ReconRun & { status: string }>();
  seen = new Map<string, ReconSeenInput>();
  ledgers: ReconLedger[] = [];
  extraApprovedLedger: ReconLedgerRow[] = [];
  diffs: ReconDiffInput[] = [];
  handedOff: string[] = [];
  closed: string[] = [];
  cleared = 0;
  pulled = 0;
  order: string[] = [];
  pending: ReconRunRef[] = EARLIER_DONE;
  overdue: string[] = [];
  owners: string[] = [];
  /** 세대를 빼앗긴 실행(다른 실행이 올렸다) */
  lost = false;
  statuses = new Map<string, ReconLedger['status']>();
  pullAnswers: number[] = [];
  pullLimits: (number | undefined)[] = [];
  pullError: Error | undefined;

  #fence(): void {
    if (this.lost) throw new ReconRunLostError();
  }
  async pendingDates(): Promise<ReconRunRef[]> {
    return this.pending;
  }
  async overdueDates(): Promise<string[]> {
    return this.overdue;
  }
  async beginRun(pg: PgName, date: string, _now: number, owner?: string): Promise<ReconRun | undefined> {
    if (owner !== undefined) this.owners.push(owner);
    const key = `${pg}:${date}`;
    const known = this.runs.get(key);
    if (known?.status === 'DONE') return undefined;
    const run = known ?? { id: `run-${key}`, pg, date, generation: 1, stage: 'LISTING' as const, listedCount: 0, matchedCount: 0, mismatchCount: 0, status: 'RUNNING' };
    this.runs.set(key, { ...run, status: 'RUNNING' });
    return { ...this.runs.get(key)! };
  }
  async saveListedPage(run: ReconRun, items: readonly ReconSeenInput[], next: string | undefined, listed: number, mismatched = 0): Promise<void> {
    this.#fence();
    this.order.push('list');
    for (const i of items) this.seen.set(i.paymentRef, i);
    const o = this.#of(run);
    this.#patch(run, { pgCursor: next, stage: next === undefined ? 'COMPARING' : 'LISTING', listedCount: o.listedCount + listed, mismatchCount: o.mismatchCount + mismatched });
  }
  async readCompareBatch(run: ReconRun, limit: number): Promise<ReconCompareRow[]> {
    const after = this.#of(run).compareAfter;
    return [...this.seen.values()]
      .sort((a, b) => (a.paymentRef < b.paymentRef ? -1 : 1))
      .filter((s) => after === undefined || s.paymentRef > after)
      .slice(0, limit)
      .map((s) => {
        const l = this.ledgers.find((x) => x.paymentRef === s.paymentRef);
        return { paymentRef: s.paymentRef, orderRef: s.orderRef, pgStatus: s.pgStatus, amount: s.amount, ...(l ? { ledger: l } : {}) };
      });
  }
  async insertDiffs(_run: ReconRun, diffs: readonly ReconDiffInput[]): Promise<ReconDiffInput[]> {
    this.order.push('diffs');
    const fresh = diffs.filter((d) => !this.diffs.some((x) => x.pg === d.pg && x.paymentRef === d.paymentRef && x.kind === d.kind));
    this.diffs.push(...fresh);
    return fresh;
  }
  async handOff(ids: readonly string[]): Promise<number> {
    this.handedOff.push(...ids);
    return ids.length;
  }
  async markClosed(pg: PgName, ref: string): Promise<void> {
    this.closed.push(`${pg}:${ref}`);
  }
  async finishCompareBatch(run: ReconRun, afterRef: string | undefined, matched: number, mismatched: number): Promise<void> {
    this.#fence();
    this.order.push('compare-done');
    const o = this.#of(run);
    this.#patch(run, { compareAfter: afterRef, stage: afterRef === undefined ? 'LEDGER' : 'COMPARING', matchedCount: o.matchedCount + matched, mismatchCount: o.mismatchCount + mismatched });
  }
  async readLedgerBatch(run: ReconRun, limit: number): Promise<ReconLedgerRow[]> {
    const after = this.#of(run).ledgerAfter;
    return this.extraApprovedLedger.filter((l) => after === undefined || l.paymentId > after.id).slice(0, limit);
  }
  async finishLedgerBatch(run: ReconRun, after: { readonly atMs: number; readonly id: string } | undefined, mismatched: number): Promise<void> {
    this.#fence();
    const o = this.#of(run);
    this.#patch(run, { ledgerAfter: after, mismatchCount: o.mismatchCount + mismatched, ...(after === undefined ? { stage: 'PULLING' as const } : {}) });
  }
  async pullUnknowns(_pg: PgName, _before: number, _now: number, limit?: number): Promise<number> {
    this.pulled += 1;
    this.pullLimits.push(limit);
    if (this.pullError !== undefined) {
      const e = this.pullError;
      this.pullError = undefined;
      throw e;
    }
    return this.pullAnswers.shift() ?? 0;
  }
  async ledgerStatus(paymentId: string): Promise<ReconLedger['status'] | undefined> {
    return this.statuses.get(paymentId);
  }
  async finishRun(run: ReconRun, status: 'DONE' | 'FAILED'): Promise<void> {
    this.#fence();
    this.#patch(run, { status } as Partial<ReconRun & { status: string }>);
  }
  async clearSeen(): Promise<number> {
    this.cleared += 1;
    return 0;
  }
  #key = (run: ReconRun) => `${run.pg}:${run.date}`;
  #of(run: ReconRun) {
    return this.runs.get(this.#key(run))!;
  }
  #patch(run: ReconRun, p: Partial<ReconRun & { status: string }>): void {
    this.runs.set(this.#key(run), { ...this.#of(run), ...p });
  }
}

class FakeGateway {
  readonly calls: { fromMs: number; toMs: number; cursor?: string; limit: number }[] = [];
  answers: (ListTransactionsResult | Error)[] = [];
  rps = 300;
  queries = new Map<string, QueryResult>();
  queryCalls: { ref: string; options?: QueryOptions }[] = [];
  constructor(readonly pg: PgName) {}
  capabilities() {
    return { callsPerSecond: this.rps } as ReturnType<PaymentGatewayPort['capabilities']>;
  }
  async query(ref: string, options?: QueryOptions): Promise<QueryResult> {
    this.queryCalls.push({ ref, ...(options === undefined ? {} : { options }) });
    return this.queries.get(ref) ?? { kind: 'UNKNOWN' };
  }
  async listTransactions(r: { fromMs: number; toMs: number; cursor?: string; limit: number }): Promise<ListTransactionsResult> {
    this.calls.push({ ...r });
    const next = this.answers.shift() ?? { kind: 'PAGE', items: [] };
    if (next instanceof Error) throw next;
    return next;
  }
}

interface Harness {
  app: PaymentReconciliation;
  store: FakeStore;
  gateway: FakeGateway;
  closes: { orderId: string; status: string }[];
  logs: unknown[];
  signals: unknown[];
  clock: FakeClock;
  slept: number[];
  closerResult: { value: 'APPLIED' | 'STALE' };
}

function harness(o: { adapters?: FakeGateway[]; onSale?: boolean; calendarThrows?: boolean } = {}): Harness {
  const clock = fakeClock({ now: NOW });
  const store = new FakeStore();
  const gateway = new FakeGateway('TOSS');
  const adapters = o.adapters ?? [gateway];
  const gateways: PaymentGateways = { of: (pg) => adapters.find((a) => a.pg === pg) as unknown as PaymentGatewayPort | undefined };
  const logs: unknown[] = [];
  const signals: unknown[] = [];
  const log: PaymentReconciliationLog = {
    mismatch: (e) => logs.push({ kind: 'mismatch', ...e }),
    failed: (e) => logs.push({ kind: 'failed', ...e }),
    done: (e) => logs.push({ kind: 'done', ...e }),
    calendarUnavailable: (e) => logs.push({ kind: 'calendar', ...e }),
    overdue: (e) => logs.push({ kind: 'overdue', ...e }),
    runLost: (e) => logs.push({ kind: 'lost', ...e }),
    recheckMissing: (e) => logs.push({ kind: 'recheck-missing', ...e }),
    mismatchSuppressed: (e) => logs.push({ kind: 'suppressed', ...e }),
  };
  const sig: PaymentReconciliationSignals = {
    run: (pg, result) => signals.push(['run', pg, result]),
    lastRun: (pg, v) => signals.push(['lastRun', pg, v]),
    mismatch: (pg, kind) => signals.push(['mismatch', pg, kind]),
    overdueDates: (pg, count) => signals.push(['overdue', pg, count]),
  };
  const calendar: OnSaleCalendar = {
    active: async () => {
      if (o.calendarThrows) throw new Error('calendar');
      return o.onSale ?? false;
    },
  };
  const closes: { orderId: string; status: string }[] = [];
  const closerResult: Harness['closerResult'] = { value: 'APPLIED' };
  const slept: number[] = [];
  const app = new PaymentReconciliation({
    store,
    gateways,
    calendar,
    log,
    signals: sig,
    clock,
    owner: 'pod-a',
    closer: {
      resolve: async (job, finish) => {
        closes.push({ orderId: job.orderId, status: finish.status });
        return closerResult.value;
      },
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
  });
  return { app, store, gateway, closes, logs, signals, clock, slept, closerResult };
}

const page = (items: PgTransaction[], nextCursor?: string): ListTransactionsResult => ({ kind: 'PAGE', items, ...(nextCursor === undefined ? {} : { nextCursor }) });

describe('P-T32 대사 실행', () => {
  test('P-T32_대형·중형 온세일 윈도우 안이면 미루고 결제사를 부르지 않는다 [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness({ onSale: true });
    await expect(h.app.runDaily()).resolves.toEqual({ deferred: true });
    expect(h.gateway.calls).toEqual([]);
  });

  test('P-T32_온세일 일정을 읽지 못하면 일정 없음으로 보고 경고 뒤 시작한다', async () => {
    const h = harness({ calendarThrows: true });
    const r = await h.app.runDaily();
    expect(r).toMatchObject({ runs: [{ pg: 'TOSS', status: 'DONE' }] });
    expect(h.logs.some((l) => (l as { kind: string }).kind === 'calendar')).toBe(true);
  });

  test('P-T32_세 단계를 돌아 끝내고 작업 표를 지운다: 맞음·건수·지표·보고 [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1), ledger('b', 2)];
    h.gateway.answers = [page([tx('a', 1), tx('b', 2)])];
    const r = await h.app.runDaily();
    expect(r).toEqual({ runs: [{ pg: 'TOSS', date: '2026-11-09', status: 'DONE', listed: 2, matched: 2, mismatched: 0 }] });
    expect(h.store.runs.get('TOSS:2026-11-09')).toMatchObject({ status: 'DONE', matchedCount: 2, mismatchCount: 0 });
    expect(h.store.cleared).toBe(1);
    expect(h.signals).toContainEqual(['run', 'TOSS', 'done']);
    expect(h.signals.some((s) => (s as unknown[])[0] === 'lastRun')).toBe(true);
  });

  test('P-T32_조회 범위는 전날 ± 10분이고 묶음마다 커서를 넘긴다(한 결제사에 동시 호출은 없다)', async () => {
    const h = harness();
    h.gateway.answers = [page([tx('a', 1)], 'c1'), page([tx('b', 2)], 'c2'), page([])];
    await h.app.runDaily();
    expect(h.gateway.calls.map((c) => c.cursor)).toEqual([undefined, 'c1', 'c2']);
    expect(h.gateway.calls[0]).toMatchObject({ fromMs: KST('2026-11-09T00:00:00') - 600_000, toMs: KST('2026-11-10T00:00:00') + 600_000, limit: 1000 });
  });

  test('P-T32_지나간 날짜를 다시 돌 때 조회 범위는 그 날짜 ± 10분이다(전날 범위가 아니다) [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    h.store.pending = [
      ...EARLIER_DONE.filter((r) => r.date !== '2026-11-07'),
      { date: '2026-11-07', status: 'RUNNING' },
      { date: '2026-11-09', status: 'DONE' },
    ];
    h.gateway.answers = [page([])];
    const r = await h.app.runDaily();
    expect(r).toMatchObject({ runs: [{ pg: 'TOSS', date: '2026-11-07', status: 'DONE' }] });
    expect(h.gateway.calls).toHaveLength(1);
    expect(h.gateway.calls[0]).toMatchObject({ fromMs: KST('2026-11-07T00:00:00') - 600_000, toMs: KST('2026-11-08T00:00:00') + 600_000 });
  });

  test('P-T32_저장된 커서에서 이어 한다(앞 묶음을 다시 부르지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    await h.store.beginRun('TOSS', '2026-11-09', NOW);
    h.store.runs.set('TOSS:2026-11-09', { ...h.store.runs.get('TOSS:2026-11-09')!, pgCursor: 'saved', listedCount: 5 });
    h.gateway.answers = [page([tx('z', 9)])];
    await h.app.runDaily();
    expect(h.gateway.calls.map((c) => c.cursor)).toEqual(['saved']);
    expect(h.store.runs.get('TOSS:2026-11-09')).toMatchObject({ listedCount: 6, status: 'DONE' });
  });

  test('P-T32_일시 실패는 그 묶음만 다시 하고 지수로 쉰다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = harness();
    h.gateway.answers = [{ kind: 'UNKNOWN' }, { kind: 'UNKNOWN' }, page([tx('a', 1)])];
    const r = await h.app.runDaily();
    expect(r).toMatchObject({ runs: [{ status: 'DONE' }] });
    expect(h.gateway.calls.map((c) => c.cursor)).toEqual([undefined, undefined, undefined]);
    expect(h.slept).toEqual(expect.arrayContaining([1000, 2000]));
  });

  test('P-T32_리뷰 고침 낮음: 429 표시를 받으면 지수보다 길게 물러난다 [ASVS v5.0.0-16.5.2]', async () => {
    const h = harness();
    h.gateway.answers = [{ kind: 'UNKNOWN', throttled: true }, page([])];
    await h.app.runDaily();
    expect(h.slept).toContain(RECON_THROTTLE_BACKOFF_MS);
    expect(RECON_THROTTLE_BACKOFF_MS).toBeGreaterThan(1000);
  });

  test('P-T32_리뷰 고침 H1: 다른 실행이 세대를 올리면 쓰기가 거절되어 멈춘다. FAILED로 쓰지 않고 작업 표를 지우지 않으며 소유자를 넘긴다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    h.store.lost = true;
    h.gateway.answers = [page([tx('a', 1)])];
    await expect(h.app.runDaily()).resolves.toMatchObject({ runs: [{ status: 'STOPPED' }] });
    expect(h.store.owners).toEqual(['pod-a']);
    expect(h.store.cleared).toBe(0);
    expect(h.logs.some((l) => (l as { kind: string }).kind === 'failed')).toBe(false);
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'lost', pg: 'TOSS', date: '2026-11-09' }));
    expect(h.signals).not.toContainEqual(['run', 'TOSS', 'failed']);
  });

  test('P-T32_리뷰 고침 H2: 대상 날짜 끝 뒤에 바뀐 원장은 목록 값과 견주지 않고 단독 조회로 다시 확인한다(시점 차이 오탐 없음) [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'CANCELED', { statusChangedAtMs: KST('2026-11-10T00:05:00') })];
    h.gateway.answers = [page([tx('a', 1, 'APPROVED')])];
    h.gateway.queries.set('a', found('a', 1, 'CANCELED'));
    await expect(h.app.runDaily()).resolves.toMatchObject({ runs: [{ status: 'DONE', matched: 1, mismatched: 0 }] });
    expect(h.gateway.queryCalls.map((c) => c.ref)).toEqual(['a']);
    expect(h.store.diffs).toEqual([]);
  });

  test('P-T32_리뷰 고침 H2: 다시 확인해도 어긋나면 불일치다', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'CANCELED', { statusChangedAtMs: KST('2026-11-10T00:05:00') })];
    h.gateway.answers = [page([tx('a', 1, 'APPROVED')])];
    h.gateway.queries.set('a', found('a', 1, 'APPROVED'));
    await h.app.runDaily();
    expect(h.store.diffs).toEqual([expect.objectContaining({ kind: 'LEDGER_CANCELED_PG_APPROVED', paymentRef: 'a' })]);
  });

  test('P-T32_리뷰 고침 H2: 다시 확인이 계속 실패하면 판단하지 않고 그 실행을 FAILED로 끝낸다(다음 날 다시)', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'CANCELED', { statusChangedAtMs: KST('2026-11-10T00:05:00') })];
    h.gateway.answers = [page([tx('a', 1, 'APPROVED')])];
    await expect(h.app.runDaily()).resolves.toMatchObject({ runs: [{ status: 'FAILED' }] });
    expect(h.store.diffs).toEqual([]);
  });

  test('P-T32_리뷰 고침 H3: 닫기 직전 결제 시도까지 대조해 조회가 CANCELED일 때만 닫는다. 다른 시도의 취소면 닫지 않고 조회로 넘긴다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'UNKNOWN', { txId: 'tx-mine' })];
    h.gateway.answers = [page([tx('a', 1, 'CANCELED')])];
    h.gateway.queries.set('a', { kind: 'UNKNOWN' }); // 포트원 어댑터는 다른 결제 시도의 답을 UNKNOWN으로 돌려준다
    await h.app.runDaily();
    expect(h.gateway.queryCalls[0]).toMatchObject({ ref: 'a', options: { expectedTxId: 'tx-mine' } });
    expect(h.closes).toEqual([]);
    expect(h.store.closed).toEqual([]);
    expect(h.store.handedOff).toEqual(['p-1']);
  });

  test('P-T32_리뷰 고침 H4: 행이 없는 날짜도 모두 돌고, 기간을 넘겨 끝내지 못한 날은 SEV2로 알린다 [ASVS v5.0.0-16.3.4]', async () => {
    const h = harness();
    h.store.pending = [];
    h.store.overdue = ['2026-10-30', '2026-11-01'];
    const r = await h.app.runDaily();
    expect((r as { runs: readonly { date: string }[] }).runs.map((x) => x.date)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']);
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'overdue', pg: 'TOSS', count: 2, oldest: '2026-10-30' }));
    expect(h.signals).toContainEqual(['overdue', 'TOSS', 2]);
  });

  test('P-T32_리뷰 고침 M7: 닫기가 STALE인데 조회가 먼저 승인을 썼으면 기록하고 SEV1을 낸다 [ASVS v5.0.0-16.3.3]', async () => {
    const h = harness();
    h.closerResult.value = 'STALE';
    h.store.ledgers = [ledger('a', 1, 'UNKNOWN')];
    h.store.statuses.set('p-1', 'APPROVED');
    h.gateway.answers = [page([tx('a', 1, 'CANCELED')])];
    h.gateway.queries.set('a', found('a', 1, 'CANCELED'));
    await h.app.runDaily();
    expect(h.store.closed).toEqual([]);
    expect(h.store.diffs).toContainEqual(expect.objectContaining({ kind: 'LEDGER_APPROVED_PG_NOT_PAID', paymentRef: 'a', ledgerStatus: 'APPROVED' }));
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'mismatch', diffKind: 'LEDGER_APPROVED_PG_NOT_PAID', orderId: ORDER(1) }));
  });

  test('P-T32_리뷰 고침 M9: 금액 비교에 쓰는 줄은 대상 날짜 안에서 고른다(여백의 뒤 거래가 앞 거래를 덮지 않는다)', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1)];
    const margin = { ...tx('a', 1, 'CANCELED'), atMs: KST('2026-11-10T00:05:00') };
    h.gateway.answers = [page([{ ...tx('a', 1), atMs: KST('2026-11-09T23:59:00') }, margin])];
    await h.app.runDaily();
    expect(h.store.seen.get('a')).toMatchObject({ pgStatus: 'APPROVED', atMs: KST('2026-11-09T23:59:00') });
  });

  test('P-T32_리뷰 고침 M10: 결과 모름 당기기는 묶음(건수 상한)으로 나누고 묶음 사이에 쉰다(승인을 굶기지 않는다) [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness();
    h.store.pullAnswers = [RECON_PULL_BATCH, RECON_PULL_BATCH, 3];
    h.gateway.answers = [page([])];
    await h.app.runDaily();
    expect(h.store.pullLimits).toEqual([RECON_PULL_BATCH, RECON_PULL_BATCH, RECON_PULL_BATCH]);
    expect(h.slept.filter((ms) => ms === RECON_PULL_PAUSE_MS)).toHaveLength(2);
  });

  test('P-T32_리뷰 고침 M13: 못 읽는 줄은 UNREADABLE로 기록·SEV1하고 나머지를 이어 간다 [ASVS v5.0.0-16.3.3]', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1)];
    h.gateway.answers = [{ kind: 'PAGE', items: [tx('a', 1)], unreadable: [{ paymentRef: 'pk-bad', orderRef: '' }] }];
    await expect(h.app.runDaily()).resolves.toMatchObject({ runs: [{ status: 'DONE', listed: 2, matched: 1, mismatched: 1 }] });
    expect(h.store.diffs).toEqual([expect.objectContaining({ kind: 'UNREADABLE', paymentRef: 'pk-bad', state: 'OPEN' })]);
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'mismatch', diffKind: 'UNREADABLE' }));
  });

  test('P-T32_리뷰 고침 낮음: 원장 쪽을 끝낸 뒤 실패해 이어 해도 건수가 겹치지 않는다', async () => {
    const h = harness();
    h.store.extraApprovedLedger = [{ ...ledger('x', 7), approvedAtMs: AT }];
    h.store.pullError = new Error('db');
    h.gateway.answers = [page([])];
    await expect(h.app.runDaily()).resolves.toMatchObject({ runs: [{ status: 'FAILED' }] });
    expect(h.store.runs.get('TOSS:2026-11-09')).toMatchObject({ mismatchCount: 1 });
    h.clock.advance(86_400_000);
    h.store.pending = [...EARLIER_DONE, { date: '2026-11-09', status: 'FAILED', finishedAtMs: NOW }];
    await h.app.runDaily();
    expect(h.store.runs.get('TOSS:2026-11-09')).toMatchObject({ status: 'DONE', mismatchCount: 1 });
  });

  test('P-T32_리뷰 고침 낮음: SEV1은 실행당 상한까지 건마다 내고 넘으면 한 줄로 요약한다(지표와 기록은 모두 남긴다) [ASVS v5.0.0-16.3.3]', async () => {
    const h = harness();
    const items = Array.from({ length: RECON_SEV1_LIMIT + 20 }, (_, i) => ({ ...tx(`r${String(i).padStart(4, '0')}`, 1) }));
    h.gateway.answers = [page(items)];
    await h.app.runDaily();
    expect(h.store.diffs).toHaveLength(RECON_SEV1_LIMIT + 20);
    expect(h.logs.filter((l) => (l as { kind: string }).kind === 'mismatch')).toHaveLength(RECON_SEV1_LIMIT);
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'suppressed', pg: 'TOSS', date: '2026-11-09', suppressed: 20 }));
    expect(h.signals.filter((s) => (s as unknown[])[0] === 'mismatch')).toHaveLength(RECON_SEV1_LIMIT + 20);
  });

  test('P-T32_한도를 넘기면 그 실행을 FAILED로 끝내고 SEV2·지표를 낸다. 다음 결제사는 돈다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.3.4]', async () => {
    const toss = new FakeGateway('TOSS');
    const portone = new FakeGateway('PORTONE');
    const h = harness({ adapters: [toss, portone] });
    toss.answers = Array.from({ length: RECON_PAGE_RETRIES + 1 }, (): ListTransactionsResult => ({ kind: 'UNKNOWN' }));
    portone.answers = [page([])];
    const r = await h.app.runDaily();
    expect(r).toMatchObject({ runs: [{ pg: 'TOSS', status: 'FAILED' }, { pg: 'PORTONE', status: 'DONE' }] });
    expect(toss.calls).toHaveLength(RECON_PAGE_RETRIES + 1);
    expect(h.store.runs.get('TOSS:2026-11-09')).toMatchObject({ status: 'FAILED' });
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'failed', pg: 'TOSS', date: '2026-11-09' }));
    expect(h.signals).toContainEqual(['run', 'TOSS', 'failed']);
  });

  test('P-T32_불일치는 기록하고 건마다 SEV1 한 번만 낸다(다시 돌아도 다시 내지 않는다) [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-2.3.4]', async () => {
    const h = harness();
    h.gateway.answers = [page([tx('a', 1)])];
    await h.app.runDaily();
    expect(h.store.diffs).toEqual([expect.objectContaining({ kind: 'PG_APPROVED_NO_LEDGER', paymentRef: 'a', state: 'OPEN', pg: 'TOSS' })]);
    expect(h.logs.filter((l) => (l as { kind: string }).kind === 'mismatch')).toEqual([expect.objectContaining({ orderId: ORDER(1), diffKind: 'PG_APPROVED_NO_LEDGER' })]);

    // 같은 건이 다음 날 다시 잡혀도 SEV1은 새로 내지 않는다
    h.store.runs.clear();
    h.logs.length = 0;
    h.gateway.answers = [page([tx('a', 1)])];
    await h.app.runDaily();
    expect(h.logs.filter((l) => (l as { kind: string }).kind === 'mismatch')).toEqual([]);
  });

  test('P-T32_늦은 입금은 csCase를 싣고 환불·재발권을 하지 않는다', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'FAILED')];
    h.gateway.answers = [page([tx('a', 1)])];
    await h.app.runDaily();
    expect(h.closes).toEqual([]);
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'mismatch', diffKind: 'LEDGER_FAILED_PG_APPROVED', csCase: 'PAYMENT_LATE_DEPOSIT' }));
  });

  test('P-T32_UNKNOWN은 조회로 넘기고(HANDED_OFF) 닫지 않는다', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'UNKNOWN')];
    h.gateway.answers = [page([tx('a', 1)])];
    await h.app.runDaily();
    expect(h.store.handedOff).toEqual(['p-1']);
    expect(h.closes).toEqual([]);
    expect(h.store.diffs).toEqual([expect.objectContaining({ kind: 'UNKNOWN_HANDED_OFF', state: 'HANDED_OFF' })]);
    expect(h.logs.filter((l) => (l as { kind: string }).kind === 'mismatch')).toEqual([]);
  });

  test('P-T32_전액 취소 UNKNOWN은 원장을 CANCELED로 닫고 CLOSED로 표시한다. 부분 취소는 닫지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const h = harness();
    h.store.ledgers = [ledger('a', 1, 'UNKNOWN'), ledger('b', 2, 'UNKNOWN')];
    h.gateway.answers = [page([tx('a', 1, 'CANCELED'), tx('b', 2, 'PARTIAL_CANCELED')])];
    h.gateway.queries.set('a', found('a', 1, 'CANCELED'));
    await h.app.runDaily();
    expect(h.closes).toEqual([{ orderId: ORDER(1), status: 'CANCELED' }]);
    expect(h.store.closed).toEqual(['TOSS:a']);
    expect(h.store.diffs).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'UNKNOWN_CANCELED_CLOSED', paymentRef: 'a' }), expect.objectContaining({ kind: 'PARTIAL_CANCELED_AT_PG', paymentRef: 'b', state: 'OPEN' })]),
    );
    expect(h.logs).toContainEqual(expect.objectContaining({ kind: 'mismatch', diffKind: 'PARTIAL_CANCELED_AT_PG', orderId: ORDER(2) }));
  });

  test('P-T32_닫기가 STALE이면(그사이 원장이 바뀜) CLOSED로 표시하지 않는다', async () => {
    const h = harness();
    h.closerResult.value = 'STALE';
    h.store.ledgers = [ledger('a', 1, 'UNKNOWN')];
    h.gateway.answers = [page([tx('a', 1, 'CANCELED')])];
    h.gateway.queries.set('a', found('a', 1, 'CANCELED'));
    await h.app.runDaily();
    expect(h.store.closed).toEqual([]);
    expect(h.store.diffs).toEqual([expect.objectContaining({ state: 'OPEN' })]);
  });

  test('P-T32_원장 쪽 단계: 결제사 기록이 없는 승인 원장을 기록·SEV1하고 UNKNOWN을 당긴다', async () => {
    const h = harness();
    h.store.extraApprovedLedger = [{ ...ledger('x', 7), approvedAtMs: AT }];
    h.gateway.answers = [page([])];
    const r = await h.app.runDaily();
    expect(r).toMatchObject({ runs: [{ mismatched: 1 }] });
    expect(h.store.diffs).toEqual([expect.objectContaining({ kind: 'LEDGER_APPROVED_NO_PG_RECORD', paymentRef: 'x', orderRef: ORDER(7) })]);
    expect(h.store.pulled).toBe(1);
  });

  test('P-T32_어댑터가 없는 결제사는 돌지 않는다', async () => {
    const h = harness({ adapters: [] });
    await expect(h.app.runDaily()).resolves.toEqual({ runs: [] });
  });

  test('P-T32_멈춤 신호가 오면 묶음 사이에서 멈추고 실행을 RUNNING으로 남긴다(다음 리더가 잇는다)', async () => {
    const h = harness();
    const stop = new AbortController();
    h.gateway.answers = [page([tx('a', 1)], 'c1'), page([tx('b', 2)])];
    const listed = h.gateway.listTransactions.bind(h.gateway);
    h.gateway.listTransactions = async (r) => {
      const a = await listed(r);
      stop.abort();
      return a;
    };
    await expect(h.app.runDaily(stop.signal)).resolves.toMatchObject({ runs: [{ status: 'STOPPED' }] });
    expect(h.store.runs.get('TOSS:2026-11-09')).toMatchObject({ status: 'RUNNING' });
    expect(h.gateway.calls).toHaveLength(1);
  });

  test('P-T32_호출 몫을 넘으면 기다린다(초당 상한의 10%, 시계로 잰다) [ASVS v5.0.0-2.4.1]', async () => {
    const h = harness();
    h.gateway.rps = 10; // 초당 1호출, 묶음 최소 1.2개
    h.gateway.answers = [page([], 'c1'), page([], 'c2'), page([], 'c3'), page([])];
    await h.app.runDaily();
    expect(h.gateway.calls).toHaveLength(4);
    // 토큰 하나를 다시 받으려면 약 1초가 든다(시작 묶음 1.2개를 쓴 뒤)
    expect(h.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2_500);
  });

  test('P-T32_처리 차례는 불일치 쓰기 → 커서·건수 쓰기다(멈춰도 불일치를 잃지 않는다)', async () => {
    const h = harness();
    h.gateway.answers = [page([tx('a', 1)])];
    await h.app.runDaily();
    expect(h.store.order.indexOf('diffs')).toBeLessThan(h.store.order.indexOf('compare-done'));
  });
});
