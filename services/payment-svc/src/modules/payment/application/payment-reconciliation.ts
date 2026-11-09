// 일일 대사 실행기(docs/features/payment.md §8 '대사의 첫 구현', docs/data.md §5, BUILD_ORDER HOT-153, ADR-0044·0086).
// 정비 일 `payment-reconciliation`이 릴레이 프로세스의 Lease 리더에서 부른다. 결제사마다 차례로 돈다(동시 호출은 늘 1개다).
// 네 단계(받기·맞추기·원장 쪽·결과 모름 당기기)는 저장소의 커서로 이어 한다. 묶음 처리 차례는 불일치 쓰기 → 조회 넘기기·닫기 → 커서·건수 쓰기다(뒤 단계 앞에서 멈춰도 다시 해서 같은 결과다).
// 실행 행의 세대가 겹침을 막는다: 시작마다 세대가 오르고, 옛 실행의 쓰기는 ReconRunLostError로 거절되어 STOPPED로 멈춘다(코드 리뷰 H1).
// 구현에서 정한 것(정본·설계에 없다):
// - 호출 몫은 PgCallGuard를 초당 상한의 10%로 만들어 쓴다. API 파드의 버킷과 메모리가 달라 몫이 합쳐지지는 않는다(정본에 적었다).
// - 묶음 안에서 같은 결제 참조는 대상 날짜 안의 줄을 앞세워 마지막 거래만 남긴다(작업 표 upsert가 묶음 안 중복을 받지 못하고, 토스는 거래마다 한 줄이다).
// - 온세일 일정을 읽지 못하면 일정 없음으로 본다(대사를 막지 않고 경고 한 줄).
// - 다시 확인 조회(코드 리뷰 H2)가 끝내 실패하면 판단하지 않고 그 실행을 FAILED로 끝낸다(묶음과 같은 규칙). 결제사가 없다고 답하면 그 줄만 판단하지 않고 경고 한 줄이다.
// - 다시 확인은 결제 시도를 대조하지 않는다(그 결제의 지금 상태를 본다). 닫기 전 대조(H3)만 대조한다.
import { type Clock } from '@peaket/platform';
import { safeErrorCode } from '../../../safe-error-code.js';
import type { ListTransactionsResult, PaymentGatewayPort, PgName, PgTransaction, PgUnreadableRow, QueryResult } from '../domain/payment-gateway.js';
import { PG_NAMES, PgCallGuard, type PgCallGuardOptions } from '../domain/pg-call-guard.js';
import type { OnSaleCalendar, PaymentGateways, PaymentReconciliationLog, PaymentReconciliationSignals, PaymentReconciliationStore, PaymentUnknownQueries, ReconCompareRow, ReconDiffInput, ReconLedgerRow, ReconRun, ReconSeenInput } from '../domain/ports.js';
import {
  decideLedgerOnly,
  decideReconciliation,
  reconChangedAfterDay,
  reconciliationCallsPerSecond,
  reconInDay,
  reconListRangeOf,
  reconRangeOf,
  RECON_BATCH,
  RECON_PAGE_LIMIT,
  RECON_PAGE_RETRIES,
  RECON_PAGE_TIMEOUT_MS,
  RECON_PULL_BATCH,
  RECON_PULL_PAUSE_MS,
  RECON_QUERY_RETRIES,
  RECON_RETRY_BASE_MS,
  RECON_SEV1_LIMIT,
  RECON_THROTTLE_BACKOFF_MS,
  RECON_TOKEN_POLL_MS,
  ReconRunLostError,
  reconStartDecision,
  reconTargets,
  reconWindowDates,
  type ReconDecision,
  type ReconLedger,
} from '../domain/reconciliation.js';
import { UNKNOWN_QUERY_TIMEOUT_MS, type UnknownQueryJob } from '../domain/unknown-resolver.js';

export interface PaymentReconciliationDeps {
  store: PaymentReconciliationStore;
  /** 전액 취소 닫기(승인 실행기·단독 조회와 같은 답 반영) */
  closer: Pick<PaymentUnknownQueries, 'resolve'>;
  gateways: PaymentGateways;
  calendar: OnSaleCalendar;
  log: PaymentReconciliationLog;
  signals: PaymentReconciliationSignals;
  clock: Clock;
  /** 실행 행에 적는 소유자(파드 이름). 기본 payment-svc-relay */
  owner?: string;
  /** 쉬기(시험이 시계를 민다). 기본 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

/** 일 하나의 보고. deferred는 온세일 윈도우에 미뤘다는 뜻이다(정비 일의 성공·실패로 세지 않는다) */
export type ReconciliationReport = { readonly deferred: true } | { readonly deferred?: false; readonly runs: readonly ReconciliationRunReport[] };

/** 실행 하나의 보고 */
export interface ReconciliationRunReport {
  readonly pg: string;
  readonly date: string;
  readonly status: 'DONE' | 'FAILED' | 'STOPPED';
  readonly listed: number;
  readonly matched: number;
  readonly mismatched: number;
}

/** 묶음이 재시도 한도를 넘겼다 */
class ReconciliationPageFailed extends Error {
  readonly code = 'PG_LIST_FAILED';
  constructor() {
    super('결제사 거래 조회가 다시 해도 실패했다');
    this.name = 'ReconciliationPageFailed';
  }
}

/** 실행 하나를 도는 동안 함께 다니는 값 */
interface RunContext {
  readonly run: ReconRun;
  readonly gateway: PaymentGatewayPort;
  readonly guard: PgCallGuard;
  readonly signal: AbortSignal | undefined;
  /** 건마다 낼 수 있는 SEV1의 남은 수와 줄인 수 */
  readonly sev1: { left: number; suppressed: number };
}

const SILENT_SIGNALS: PgCallGuardOptions['signals'] = { throttled: () => undefined, limit: () => undefined, inflight: () => undefined, saturated: () => undefined };
const SILENT_LOG: PgCallGuardOptions['log'] = { throttledFirst: () => undefined };
const DEFAULT_OWNER = 'payment-svc-relay';
const MATCH: ReconDecision = { kind: 'MATCH' };
/** 닫기가 STALE인데 조회가 먼저 승인을 쓴 경우(코드 리뷰 M7): 결제사는 취소했는데 원장은 승인이다 */
const CLOSED_BUT_APPROVED: ReconDecision = { kind: 'DIFF', diff: 'LEDGER_APPROVED_PG_NOT_PAID', action: 'NONE', sev1: true };
const UNREADABLE: ReconDecision = { kind: 'DIFF', diff: 'UNREADABLE', action: 'NONE', sev1: true };

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 일일 대사. runDaily 한 번이 어댑터가 있는 결제사마다 지난 7일 [가정]의 끝내지 못한 날을 돈다 */
export class PaymentReconciliation {
  constructor(readonly deps: PaymentReconciliationDeps) {}

  /** 하루치를 돈다. 시작할 때가 아니면 deferred를 돌려준다. 실행 하나의 실패는 보고에 담고 던지지 않는다(다음 날 다시) */
  async runDaily(signal?: AbortSignal): Promise<ReconciliationReport> {
    const now = this.deps.clock.now();
    if (reconStartDecision(now, await this.#onSale(now)) === 'DEFER') return { deferred: true };
    const fromDate = reconWindowDates(now)[0]!;
    const runs: ReconciliationRunReport[] = [];
    for (const pg of PG_NAMES) {
      const gateway = this.#gatewayOf(pg);
      if (gateway === undefined) continue;
      await this.#reportOverdue(pg, fromDate);
      const targets = reconTargets(await this.deps.store.pendingDates(pg, fromDate), now);
      for (const date of targets) {
        if (signal?.aborted) return { runs };
        const report = await this.#runOne(pg, gateway, date, signal);
        if (report !== undefined) runs.push(report);
      }
    }
    return { runs };
  }

  #gatewayOf(pg: PgName): PaymentGatewayPort | undefined {
    try {
      return this.deps.gateways.of(pg);
    } catch {
      return undefined;
    }
  }

  /** 온세일 윈도우 안인가. 일정을 읽지 못하면 일정 없음으로 본다(경고 한 줄) */
  async #onSale(nowMs: number): Promise<boolean> {
    try {
      return await this.deps.calendar.active(nowMs);
    } catch (err) {
      this.deps.log.calendarUnavailable({ code: safeErrorCode(err) });
      return false;
    }
  }

  /** 기간을 넘겨 끝내지 못한 날을 지표로 내고, 있으면 결제사마다 SEV2 한 줄이다(코드 리뷰 H4) */
  async #reportOverdue(pg: PgName, fromDate: string): Promise<void> {
    const overdue = await this.deps.store.overdueDates(pg, fromDate);
    this.deps.signals.overdueDates(pg, overdue.length);
    if (overdue.length > 0) this.deps.log.overdue({ pg, count: overdue.length, oldest: overdue[0]! });
  }

  /** 실행 하나. 끝나면 보고를 돌려주고, 이미 DONE이면 undefined다 */
  async #runOne(pg: PgName, gateway: PaymentGatewayPort, date: string, signal: AbortSignal | undefined): Promise<ReconciliationRunReport | undefined> {
    const { clock, store, signals, log } = this.deps;
    const started = clock.monotonicMs();
    const sev1 = { left: RECON_SEV1_LIMIT, suppressed: 0 };
    let run: ReconRun | undefined;
    try {
      run = await store.beginRun(pg, date, clock.now(), this.deps.owner ?? DEFAULT_OWNER);
      if (run === undefined) return undefined;
      const outcome = await this.#stages({ run, gateway, guard: this.#guardOf(gateway), signal, sev1 });
      if (outcome === 'STOPPED') return reportOf(pg, date, 'STOPPED', run);
      await store.finishRun(run, 'DONE', clock.now());
      const report = reportOf(pg, date, 'DONE', run);
      await store.clearSeen(run).catch(() => undefined);
      const seconds = (clock.monotonicMs() - started) / 1000;
      const perSecond = seconds > 0 ? Math.round(report.listed / seconds) : report.listed;
      signals.run(pg, 'done');
      signals.lastRun(pg, { transactions: report.listed, mismatches: report.mismatched, seconds, perSecond });
      log.done({ pg, date, listed: report.listed, matched: report.matched, mismatched: report.mismatched, seconds, perSecond });
      return report;
    } catch (err) {
      // 다른 실행이 이어 받았다. 실패가 아니고, 실행 행과 작업 표는 이제 그 실행의 것이다
      if (err instanceof ReconRunLostError) {
        log.runLost({ pg, date });
        return run === undefined ? { pg, date, status: 'STOPPED', listed: 0, matched: 0, mismatched: 0 } : reportOf(pg, date, 'STOPPED', run);
      }
      const code = err instanceof ReconciliationPageFailed ? err.code : safeErrorCode(err);
      signals.run(pg, 'failed');
      log.failed({ pg, date, code });
      if (run !== undefined) await store.finishRun(run, 'FAILED', clock.now()).catch(() => undefined);
      return run === undefined ? { pg, date, status: 'FAILED', listed: 0, matched: 0, mismatched: 0 } : reportOf(pg, date, 'FAILED', run);
    } finally {
      if (sev1.suppressed > 0) log.mismatchSuppressed({ pg, date, suppressed: sev1.suppressed });
    }
  }

  /** 단계 넷. 저장소의 단계·커서로 시작한다. 멈춤 신호가 오면 STOPPED다 */
  async #stages(c: RunContext): Promise<'DONE' | 'STOPPED'> {
    const { run, signal } = c;
    const list = reconListRangeOf(run.date);
    while (run.stage === 'LISTING') {
      if (signal?.aborted) return 'STOPPED';
      const page = await this.#listPage(c, list.fromMs, list.toMs);
      if (page === undefined) return 'STOPPED';
      const unreadable = page.unreadable ?? [];
      await this.#recordUnreadable(c, unreadable);
      const listed = page.items.length + unreadable.length;
      await this.deps.store.saveListedPage(run, latestPerRef(page.items, run.date), page.nextCursor, listed, unreadable.length);
      mutate(run, { listedCount: run.listedCount + listed, mismatchCount: run.mismatchCount + unreadable.length, ...(page.nextCursor === undefined ? { pgCursor: undefined, stage: 'COMPARING' as const } : { pgCursor: page.nextCursor }) });
    }
    while (run.stage === 'COMPARING') {
      if (signal?.aborted) return 'STOPPED';
      if (!(await this.#compareBatch(c))) return 'STOPPED';
    }
    while (run.stage === 'LEDGER') {
      if (signal?.aborted) return 'STOPPED';
      await this.#ledgerBatch(c);
    }
    return this.#pullUnknowns(c);
  }

  #guardOf(gateway: PaymentGatewayPort): PgCallGuard {
    const callsPerSecond = reconciliationCallsPerSecond(gateway.capabilities().callsPerSecond);
    return new PgCallGuard({ pg: gateway.pg, callsPerSecond, channelBulkhead: 1, podCount: 1, clock: this.deps.clock, signals: SILENT_SIGNALS, log: SILENT_LOG });
  }

  /** 토큰 하나를 기다려 쓴다. 멈춤 신호가 오면 거짓이다 */
  async #takeToken({ guard, signal }: RunContext): Promise<boolean> {
    const sleep = this.deps.sleep ?? sleepDefault;
    while (!guard.tryTakeToken()) {
      if (signal?.aborted) return false;
      await sleep(RECON_TOKEN_POLL_MS);
    }
    return true;
  }

  /** 다시 부르기 전에 쉰다. 429 표시가 있으면 호출 몫을 낮추고 더 길게 물러난다(코드 리뷰 낮음) */
  async #backoff({ guard }: RunContext, attempt: number, throttled: true | undefined): Promise<void> {
    const sleep = this.deps.sleep ?? sleepDefault;
    if (throttled) guard.noteThrottled({ first: true });
    await sleep(Math.max(RECON_RETRY_BASE_MS * 2 ** attempt, throttled ? RECON_THROTTLE_BACKOFF_MS : 0));
  }

  /** 묶음 하나를 받는다. 일시 실패는 그 묶음만 다시 하고 한도를 넘으면 던진다. 멈춤 신호가 오면 undefined다 */
  async #listPage(c: RunContext, fromMs: number, toMs: number): Promise<Extract<ListTransactionsResult, { kind: 'PAGE' }> | undefined> {
    const cursor = c.run.pgCursor;
    for (let attempt = 0; ; attempt += 1) {
      if (!(await this.#takeToken(c))) return undefined;
      const page = await c.gateway.listTransactions({ fromMs, toMs, limit: RECON_PAGE_LIMIT, timeoutMs: RECON_PAGE_TIMEOUT_MS, ...(cursor === undefined ? {} : { cursor }) });
      if (page.kind === 'PAGE') return page;
      if (attempt >= RECON_PAGE_RETRIES) throw new ReconciliationPageFailed();
      await this.#backoff(c, attempt, page.throttled);
    }
  }

  /** 단독 조회 한 번(토큰을 쓰고, 일시 실패는 다시 한다). 한도를 넘기면 마지막 답(UNKNOWN)이고, 멈춤 신호가 오면 undefined다 */
  async #query(c: RunContext, ledger: ReconLedger, o: { readonly pinAttempt: boolean }): Promise<QueryResult | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      if (!(await this.#takeToken(c))) return undefined;
      const answer = await c.gateway.query(ledger.paymentRef, { timeoutMs: UNKNOWN_QUERY_TIMEOUT_MS, ...(o.pinAttempt && ledger.txId !== undefined ? { expectedTxId: ledger.txId } : {}) });
      if (answer.kind !== 'UNKNOWN' || attempt >= RECON_QUERY_RETRIES) return answer;
      await this.#backoff(c, attempt, answer.throttled);
    }
  }

  /** 못 읽는 줄을 불일치로 기록한다(건마다 SEV1, 코드 리뷰 M13). 원장은 건드리지 않는다 */
  async #recordUnreadable(c: RunContext, rows: readonly PgUnreadableRow[]): Promise<void> {
    if (rows.length === 0) return;
    const diffs = rows.map((r): ReconDiffInput => ({ pg: c.run.pg, orderRef: r.orderRef, paymentRef: r.paymentRef, kind: 'UNREADABLE', state: 'OPEN' }));
    this.#report(c, rows.map((row) => ({ row, decision: UNREADABLE })), await this.deps.store.insertDiffs(c.run, diffs));
  }

  /**
   * 대상 날짜 끝 뒤에 바뀐 원장은 그날 목록 값과 견주지 않고 단독 조회의 지금 값으로 바꾼다(코드 리뷰 H2).
   * @returns 판단에 쓸 줄. 결제사가 없다고 답했으면 null(판단하지 않는다), 멈춤 신호가 오면 undefined다
   * @throws ReconciliationPageFailed 다시 해도 답을 받지 못함
   */
  async #currentRow(c: RunContext, row: ReconCompareRow): Promise<ReconCompareRow | null | undefined> {
    if (row.ledger === undefined || !reconChangedAfterDay(row.ledger, c.run.date)) return row;
    const answer = await this.#query(c, row.ledger, { pinAttempt: false });
    if (answer === undefined) return undefined;
    if (answer.kind === 'UNKNOWN') throw new ReconciliationPageFailed();
    if (answer.kind === 'NOT_FOUND') {
      this.deps.log.recheckMissing({ pg: c.run.pg, orderId: row.ledger.orderId });
      return null;
    }
    return { ...row, orderRef: answer.orderRef, pgStatus: answer.status, amount: answer.amount };
  }

  /** 맞추기 묶음 하나. 다 읽으면 단계를 LEDGER로 넘긴다. 멈춤 신호가 오면 거짓이다(그 묶음은 커서를 쓰지 않아 다시 한다) */
  async #compareBatch(c: RunContext): Promise<boolean> {
    const { store, clock } = this.deps;
    const { run } = c;
    const rows = await store.readCompareBatch(run, RECON_BATCH);
    const decided: { row: ReconCompareRow; decision: ReconDecision }[] = [];
    for (const row of rows) {
      const current = await this.#currentRow(c, row);
      if (current === undefined) return false;
      decided.push(current === null ? { row, decision: MATCH } : { row: current, decision: decideReconciliation(current, current.ledger, run.pg) });
    }
    const diffs = decided.flatMap(({ row, decision }) => (decision.kind === 'DIFF' ? [diffOf(run.pg, row, row.ledger, decision)] : []));
    this.#report(c, decided, await store.insertDiffs(run, diffs));
    const handOffs = decided.flatMap(({ row, decision }) => (decision.kind === 'DIFF' && decision.action === 'REQUERY' && row.ledger ? [row.ledger.paymentId] : []));
    if (handOffs.length > 0) await store.handOff(handOffs, clock.now());
    const approvedAfterClose: { row: ReconCompareRow; decision: ReconDecision }[] = [];
    for (const { row, decision } of decided) {
      if (decision.kind !== 'DIFF' || decision.action !== 'CLOSE_CANCELED' || row.ledger === undefined) continue;
      const answer = await this.#query(c, row.ledger, { pinAttempt: true });
      if (answer === undefined) return false;
      // 목록의 취소가 이 결제 시도의 전액 취소일 때만 닫는다(포트원은 결제 ID 하나에 시도가 여럿이다, 코드 리뷰 H3). 아니면 단독 조회로 넘긴다
      if (answer.kind !== 'FOUND' || answer.status !== 'CANCELED' || answer.orderRef !== row.ledger.orderId) {
        await store.handOff([row.ledger.paymentId], clock.now());
        continue;
      }
      const result = await this.deps.closer.resolve(jobOf(row.ledger), { status: 'CANCELED', result: 'DECLINED' });
      if (result === 'APPLIED') await store.markClosed(run.pg, row.paymentRef, decision.diff);
      else if ((await store.ledgerStatus(row.ledger.paymentId)) === 'APPROVED') approvedAfterClose.push({ row: { ...row, ledger: { ...row.ledger, status: 'APPROVED' } }, decision: CLOSED_BUT_APPROVED });
    }
    const extraDiffs = approvedAfterClose.map(({ row, decision }) => diffOf(run.pg, row, row.ledger, decision as Extract<ReconDecision, { kind: 'DIFF' }>));
    if (extraDiffs.length > 0) this.#report(c, approvedAfterClose, await store.insertDiffs(run, extraDiffs));
    const after = rows.length < RECON_BATCH ? undefined : rows[rows.length - 1]!.paymentRef;
    const matched = rows.length - diffs.length;
    const mismatched = diffs.length + extraDiffs.length;
    await store.finishCompareBatch(run, after, matched, mismatched);
    mutate(run, { matchedCount: run.matchedCount + matched, mismatchCount: run.mismatchCount + mismatched, ...(after === undefined ? { compareAfter: undefined, stage: 'LEDGER' as const } : { compareAfter: after }) });
    return true;
  }

  /** 원장 쪽 묶음 하나. 승인 행을 잘라 읽고 작업 표에 없는 행만 본다. 다 읽으면 단계를 PULLING으로 넘긴다 */
  async #ledgerBatch(c: RunContext): Promise<void> {
    const { store } = this.deps;
    const { run } = c;
    const page = await store.readLedgerBatch(run, RECON_BATCH);
    const decided = page.filter((row) => row.seen !== true).map((row) => ({ row, decision: decideLedgerOnly(row) }));
    const diffs = decided.flatMap(({ row, decision }) => (decision.kind === 'DIFF' ? [diffOfLedger(run.pg, row, decision)] : []));
    this.#report(c, decided, await store.insertDiffs(run, diffs));
    const last = page.length < RECON_BATCH ? undefined : page[page.length - 1];
    const after = last === undefined ? undefined : { atMs: last.approvedAtMs, id: last.paymentId };
    await store.finishLedgerBatch(run, after, diffs.length);
    mutate(run, { mismatchCount: run.mismatchCount + diffs.length, ...(after === undefined ? { ledgerAfter: undefined, stage: 'PULLING' as const } : { ledgerAfter: after }) });
  }

  /** 결과 모름의 다음 조회를 묶음(건수 상한)으로 당긴다(코드 리뷰 M10). 시각을 처음 값으로 고정해 한 행을 두 번 당기지 않는다 */
  async #pullUnknowns({ run, signal }: RunContext): Promise<'DONE' | 'STOPPED'> {
    const sleep = this.deps.sleep ?? sleepDefault;
    const beforeMs = reconRangeOf(run.date).toMs;
    const nowMs = this.deps.clock.now();
    for (;;) {
      if (signal?.aborted) return 'STOPPED';
      if ((await this.deps.store.pullUnknowns(run.pg, beforeMs, nowMs, RECON_PULL_BATCH)) < RECON_PULL_BATCH) return 'DONE';
      await sleep(RECON_PULL_PAUSE_MS);
    }
  }

  /** 이번에 처음 쓴 불일치만 지표를 내고, 실행당 상한까지 건마다 SEV1을 낸다(넘는 수는 실행 끝에 한 줄로 요약한다) */
  #report({ run, sev1 }: RunContext, decided: readonly { row: { paymentRef: string; orderRef?: string; orderId?: string }; decision: ReconDecision }[], fresh: readonly ReconDiffInput[]): void {
    const { log, signals } = this.deps;
    for (const d of fresh) {
      signals.mismatch(run.pg, d.kind);
      const entry = decided.find((x) => x.row.paymentRef === d.paymentRef);
      if (entry === undefined || entry.decision.kind !== 'DIFF' || !entry.decision.sev1 || entry.decision.diff !== d.kind) continue;
      if (sev1.left <= 0) {
        sev1.suppressed += 1;
        continue;
      }
      sev1.left -= 1;
      const orderId = entry.row.orderId ?? d.orderRef;
      log.mismatch({ pg: run.pg, diffKind: d.kind, ...(orderId === '' ? {} : { orderId }), ...(entry.decision.csCase === undefined ? {} : { csCase: entry.decision.csCase }) });
    }
  }
}

function reportOf(pg: PgName, date: string, status: ReconciliationRunReport['status'], run: ReconRun): ReconciliationRunReport {
  return { pg, date, status, listed: run.listedCount, matched: run.matchedCount, mismatched: run.mismatchCount };
}

function mutate(run: ReconRun, patch: Partial<ReconRun>): void {
  Object.assign(run, patch);
}

/** a가 b를 대신하는가: 대상 날짜 안의 줄이 여백의 줄보다 앞서고(코드 리뷰 M9), 같은 쪽이면 더 늦은 줄이다(같은 시각이면 뒤의 줄) */
function outranks(a: PgTransaction, b: ReconSeenInput, date: string): boolean {
  const aIn = reconInDay(a.atMs, date);
  return aIn !== reconInDay(b.atMs, date) ? aIn : a.atMs >= b.atMs;
}

/** 묶음 안에서 결제 참조마다 한 줄만 남긴다(outranks) */
function latestPerRef(items: readonly PgTransaction[], date: string): ReconSeenInput[] {
  const latest = new Map<string, ReconSeenInput>();
  for (const item of items) {
    const known = latest.get(item.paymentRef);
    if (known === undefined || outranks(item, known, date)) latest.set(item.paymentRef, { paymentRef: item.paymentRef, orderRef: item.orderRef, pgStatus: item.status, amount: item.amount, atMs: item.atMs });
  }
  return [...latest.values()];
}

const STATE_OF = { NONE: 'OPEN', REQUERY: 'HANDED_OFF', CLOSE_CANCELED: 'OPEN' } as const;

function diffOf(pg: PgName, row: ReconCompareRow, ledger: ReconLedger | undefined, decision: Extract<ReconDecision, { kind: 'DIFF' }>): ReconDiffInput {
  return {
    pg,
    orderRef: ledger?.orderId ?? row.orderRef,
    paymentRef: row.paymentRef,
    kind: decision.diff,
    state: STATE_OF[decision.action],
    ...(ledger === undefined ? {} : { ledgerStatus: ledger.status, ledgerAmount: ledger.amount }),
    pgStatus: row.pgStatus,
    pgAmount: row.amount,
  };
}

function diffOfLedger(pg: PgName, row: ReconLedgerRow, decision: Extract<ReconDecision, { kind: 'DIFF' }>): ReconDiffInput {
  return { pg, orderRef: row.orderId, paymentRef: row.paymentRef, kind: decision.diff, state: STATE_OF[decision.action], ledgerStatus: row.status, ledgerAmount: row.amount };
}

/** 원장 값으로 단독 조회 잡기 모양을 만든다(closer의 resolve가 쓴다. 잡기 칸은 답 반영에 쓰지 않는다) */
function jobOf(ledger: ReconLedger): UnknownQueryJob {
  return { paymentId: ledger.paymentId, orderId: ledger.orderId, eventId: ledger.eventId, attemptNo: ledger.attemptNo, pg: ledger.pg, paymentRef: ledger.paymentRef, amount: ledger.amount, queryAttempts: 0, claimedNextQueryAtMs: 0, anomalyLogged: false, ...(ledger.txId === undefined ? {} : { txId: ledger.txId }) };
}
