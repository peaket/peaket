// 환급 실행기(GAT-080·GAT-090, docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1·§7.1).
// ① 입장 기록 마감 뒤 환급할 REQUESTED(refund_due_at이 지난 것) ② 결제사 결과 모름·일시 실패로 남은 REFUND_PENDING(next_refund_at이 지난 것)을
// 같은 결제사 취소(cancel-{cancellationId})로 이어 간다. 성공하면 REFUNDED, 업무 거절·재시도 소진이면 refund_failed_at을 남겨 CS 처리함 대상으로 보낸다.
// ①은 결제사로 보내기 전에 ticket-svc 입장 기록(GetEntryRecords)을 본다(BAT-420 GAT-090, '입장 기록 대조와 환급 집기'):
//   들어감·통과 기록이 있으면 환급하지 않고 가장 이른 입장 시각을 남겨 CS '이상 표시'를 열고, 모르면(조회 실패·표 없음) 이번 틱은 건너뛰며,
//   없으면 조건부로 집은(REQUESTED → REFUND_PENDING) 뒤에만 결제사를 부른다. 상태 쓰기는 REFUND_PENDING 행에만 해 그사이 무효를 덮지 않는다.
// 회차 취소(CANCEL)가 요청된 회차의 보류 취소는 그 요청의 미룸(event_refund_hold)이 걸린 동안 집지 않는다(BAT-420 몫 D, transfer-refund §5). 틱 맨 앞에
// 기한이 지난 미룸을 풀고 풀린 줄마다 SEV2 로그를 한 번 남긴다. 풀기가 실패해도 그 틱은 이어 간다(기한 판단은 집기 SQL이 한다, 보충 2).
// 회차 취소 요청이 만들거나 전환한 REFUND_PENDING 행(event_cancellation_request_id 있음)은 집지 않는다. 그 행은 일괄 환불 실행기만 결제사로 보낸다(웨이브 끝 리뷰 K1·C1).
// CS 건(환급 실패·이상 표시)은 ops-svc가 2xx로 받아야 연 것이다(웨이브 끝 리뷰 S1, 다시 보기 2 N2). 다시 열기 포트(csOutbox)가 꽂힌 조립에서는 처리 중에
// ops-svc를 부르지 않고 행에 표시(refund_failed_at·entry_recorded_at)만 남기며, 건은 그 틱의 집기·결제사 호출이 끝난 뒤 틱 끝 한 곳에서 환급 실패 → 이상 표시
// 차례로, 5초 [가정] 예산과 잇따른 무응답 멈춤 안에서 연다(다시 보기 2 N1, transfer-refund §3.1 ⑥, cs-case-reopen.ts). 포트가 없는 옛 조립만 처리 중에 한 번 연다.
// 카드 결제는 계좌가 필요 없고, 가상계좌는 환불 계좌를 저장하지 않으므로(POL-014) 이 실행기는 계좌를 싣지 않는다. payment-svc가 REFUND_ACCOUNT_REQUIRED로 답하면
// 그 행을 계좌 대기(refund_account_required_at, next_refund_at 빔, 재시도 횟수 그대로)로 두고 더 집지 않는다. CS '환불 대기'(REFUND_ACCOUNT_PENDING) 건은
// 틱 끝 다시 열기가 환급 실패 다음 차례로 연다(회차 취소 요청 ID가 달린 계좌 대기 행도 여기서 연다, BUILD_ORDER GAT-090, docs/features/payment.md §6 '계좌 대기').
import type { MaintenanceTask } from '@peaket/platform';
import { REFUND_RETRY_MAX_ATTEMPTS, refundRetryDelayMs, type DueRefund } from '../domain/cancellation.js';
import type { CsCaseOpenSignals, CsCaseOutbox, EventRefundHolds, RefundAccountNotice } from '../domain/event-refund-ports.js';
import { ENTRY_LOOKUP_DEADLINE_MS, type CancellationClaims, type CancellationOrders, type CancellationWrites, type EntryFlagNotice, type EntryRecords, type EntryRecordView, type PaymentCancellations, type RefundFailureNotice } from '../domain/ports.js';
import { CsCaseReopenTick } from './cs-case-reopen.js';

export interface RefundAfterEntryDeps {
  writes: CancellationWrites;
  payments: PaymentCancellations;
  nowMs(): number;
  /** 재시도 소진·업무 거절을 CS 처리함에 잇는 포트. 없으면 refund_failed_at만 남긴다(ops-svc 계약 전) */
  failureNotice?: RefundFailureNotice;
  /** ticket-svc 입장 기록 대조(GetEntryRecords). 없으면 시작하지 않는다(마감 뒤 환급이 입장 기록을 보지 않게 되므로) */
  entries?: EntryRecords;
  /** 보류 취소 조건부 집기·입장 기록 남기기. 없으면 시작하지 않는다 */
  claims?: CancellationClaims;
  /** 입장 기록이 나온 취소의 CS '이상 표시'(FLAGGED). 없으면 행에만 남긴다 */
  flags?: EntryFlagNotice;
  log?: { warn(o: object, msg: string): void; error(o: object, msg: string): void };
  /** 기한이 지난 미룸 풀기(BAT-420 몫 D). 틱 맨 앞에 부르고 풀린 줄마다 SEV2 로그를 남긴다. 없으면 풀기를 건너뛴다(기한 판단은 집기 SQL이 한다) */
  holds?: Pick<EventRefundHolds, 'releaseExpired'>;
  /**
   * 결제사 CANCELLED 뒤 REFUNDED 쓰기가 0행이면 그 행을 다시 읽는다(BAT-420 리뷰 D1, transfer-refund §3.1 ⑤).
   * VOIDED일 때만 SEV1 cancellation-refunded-after-void, REFUNDED면(다른 길이 먼저 끝냄) 환급으로 센다, 그 밖은 경고 cancellation-refund-state-unexpected.
   * 없으면 다시 읽지 못하므로 전처럼 SEV1이다(시작 조립은 늘 꽂는다)
   */
  orders?: Pick<CancellationOrders, 'findCancellation'>;
  /**
   * 웨이브 끝 리뷰 S1·다시 보기 2 N1·N2: 열지 않은 환급 실패 건(refund_failed_at 있음·refund_failed_opened_at 빔, 회차 취소 요청 ID 없음)과 이상 표시 건
   * (entry_recorded_at 있음·entry_flag_opened_at 빔)을 틱 끝에서 종류마다 100건 [가정]까지 행마다 다시 열고, ops-svc가 2xx로 받은 행만 연 시각을 쓴다.
   * 꽂히면 처리 중에는 ops-svc를 부르지 않는다. 없으면(옛 조립) 실패 표시·입장 기록을 남길 때 한 번만 연다
   */
  csOutbox?: Pick<CsCaseOutbox, 'pendingFlags' | 'markFlagOpened' | 'pendingRefundFailures' | 'markRefundFailureOpened' | 'pendingRefundAccounts' | 'markRefundAccountOpened'>;
  /** CS '환불 대기'(REFUND_ACCOUNT_PENDING) 건 열기(BUILD_ORDER GAT-090). csOutbox의 계좌 대기 목록과 함께 있을 때만 틱 끝에 연다 */
  accountNotice?: RefundAccountNotice;
  /** 웨이브 끝 리뷰 C2·S1: 지표 purchase_cs_case_open_failures_total{kind}. 이상 표시 건 열기가 실패한 행마다 FLAGGED 하나(다시 보기 2: 환급 실패는 REFUND_FAILED, 멈춤은 cut) */
  csCaseOpenFailures?: CsCaseOpenSignals;
}

/** 한 번에 처리하는 취소 수 [가정] */
export const REFUND_AFTER_ENTRY_BATCH = 100;
/** 한 틱에 푸는 기한 지난 미룸 수 [가정] */
const HOLD_RELEASE_BATCH = 100;
/** 입장 기록을 한 번에 묻는 표 상한(ticket.proto GetEntryRecords 100장 [가정]) */
const ENTRY_LOOKUP_CHUNK = 100;

export interface RefundAfterEntryResult {
  readonly refunded: number;
  readonly pending: number;
  readonly failed: number;
  /** 입장 기록이 나와 환급하지 않고 이상 표시로 넘긴 보류 취소 */
  readonly entryRecorded: number;
  /** 입장 기록을 확인하지 못해(조회 실패·표 모름) 이번 틱에 건너뛴 보류 취소 */
  readonly unverified: number;
  /** 회차 취소 요청의 미룸 때문에 이번 틱에 집지 않은 마감 지난 보류 취소(BAT-420 몫 D). 진행 중 일괄 환불로 건너뛴 행은 세지 않는다 */
  readonly held: number;
  /** payment가 REFUND_ACCOUNT_REQUIRED로 답해 계좌 대기로 둔 취소(BUILD_ORDER GAT-090). 있을 때만 싣는다 */
  readonly accountPending?: number;
}

export class RefundAfterEntry {
  readonly #entries: EntryRecords;
  readonly #claims: CancellationClaims;

  constructor(private readonly deps: RefundAfterEntryDeps) {
    if (!deps.entries || !deps.claims) throw new Error('환급 실행기에 입장 기록 대조(entries)·조건부 집기(claims)를 꽂아야 한다(BAT-420 GAT-090 A6)');
    this.#entries = deps.entries;
    this.#claims = deps.claims;
  }

  /** 한 틱: 기한 지난 미룸 풀기 → 집기·결제사 호출 → (처리가 던져도) 틱 끝 CS 건 다시 열기(다시 보기 2 N1) */
  async run(limit = REFUND_AFTER_ENTRY_BATCH): Promise<RefundAfterEntryResult> {
    try {
      return await this.#runRefunds(limit);
    } finally {
      await this.#reopenCases();
    }
  }

  async #runRefunds(limit: number): Promise<RefundAfterEntryResult> {
    await this.#releaseExpiredHolds();
    const due = await this.deps.writes.dueRefunds(this.deps.nowMs(), limit);
    let refunded = 0;
    let pending = 0;
    let failed = 0;
    let entryRecorded = 0;
    let unverified = 0;
    let held = 0;
    let accountPending = 0;
    const records = await this.#lookup(due.filter((c) => c.status === 'REQUESTED' && c.held !== true));
    for (const c of due) {
      if (c.held === true) {
        // 미룸이 걸린 회차의 보류 취소는 입장 기록도 묻지 않고 결제사도 부르지 않는다(판정이 끝나면 풀리거나 확정이 전환한다)
        held++;
        continue;
      }
      if (c.status === 'REQUESTED') {
        if (!records) {
          unverified++;
          continue;
        }
        const record = c.ticketId !== undefined ? records.get(c.ticketId) : undefined;
        if (!record || !record.found) {
          // 표를 모르면 입장한 것과 같게 다룬다(환급하지 않고 다음 틱에 다시 묻는다)
          this.deps.log?.warn({ event: 'cancellation-entry-ticket-unknown', cancellationId: c.cancellationId }, 'cancellation-entry-ticket-unknown: ticket-svc가 그 표를 모른다(환급하지 않음)');
          unverified++;
          continue;
        }
        if (record.entered) {
          if (await this.#recordEntry(c, record)) entryRecorded++;
          continue;
        }
        // 다른 실행기가 먼저 집었거나 그사이 상태가 바뀌었으면 결제사를 부르지 않는다
        if (!(await this.#claims.claimDue(c.cancellationId, this.deps.nowMs()))) continue;
      }
      const r = await this.deps.payments.cancel({ cancellationId: c.cancellationId, orderId: c.orderId, amount: c.amount, reason: c.reason, refundAttempt: c.refundAttempt ?? 0, deadlineMs: 5_000 });
      if (r === 'CANCELLED') {
        const applied = await this.deps.writes.updateStatus({ cancellationId: c.cancellationId, status: 'REFUNDED', nowMs: this.deps.nowMs() });
        if (applied === false) {
          if (await this.#refundedElsewhere(c)) refunded++;
          continue;
        }
        refunded++;
        continue;
      }
      if (r === 'REFUND_ACCOUNT_REQUIRED') {
        // 계좌 대기: 재시도 횟수·실패 표시에 넣지 않고 next_refund_at을 비워 다시 집지 않는다(건은 틱 끝이 연다)
        const nowMs = this.deps.nowMs();
        const marked = this.deps.writes.markRefundAccountRequired
          ? await this.deps.writes.markRefundAccountRequired({ cancellationId: c.cancellationId, nowMs })
          : await this.deps.writes.markRefundFailed({ cancellationId: c.cancellationId, attempts: c.attempts, lastError: r, nowMs });
        if (marked !== false) accountPending++;
        continue;
      }
      const attempts = c.attempts + 1;
      if (r === 'REJECTED' || attempts >= REFUND_RETRY_MAX_ATTEMPTS) {
        const marked = await this.deps.writes.markRefundFailed({ cancellationId: c.cancellationId, attempts, lastError: r, nowMs: this.deps.nowMs() });
        if (marked === false) continue;
        // 행에는 실패 표시가 남았으므로 건 열기가 실패해도 실패로 센다(다시 보기 2 N2)
        await this.#openRefundFailureNow({ cancellationId: c.cancellationId, orderId: c.orderId, attempts, lastError: r });
        failed++;
        continue;
      }
      const scheduled = await this.deps.writes.scheduleRefundRetry({
        cancellationId: c.cancellationId,
        attempts,
        nextRetryAtMs: this.deps.nowMs() + refundRetryDelayMs(attempts),
        lastError: r,
        nowMs: this.deps.nowMs(),
      });
      if (scheduled === false) continue;
      pending++;
    }
    return { refunded, pending, failed, entryRecorded, unverified, held, ...(accountPending > 0 ? { accountPending } : {}) };
  }

  /** 기한이 지난 미룸을 풀고 풀린 줄마다 SEV2를 한 번 남긴다(조건부 갱신이라 같은 줄은 한 번만 나온다). 실패는 경고만 남기고 틱을 이어 간다 */
  async #releaseExpiredHolds(): Promise<void> {
    if (!this.deps.holds) return;
    let released: readonly { eventId: string; cancellationRequestId: string }[];
    try {
      released = await this.deps.holds.releaseExpired(this.deps.nowMs(), HOLD_RELEASE_BATCH);
    } catch (err) {
      this.deps.log?.warn(
        { event: 'event-refund-hold-release-failed', err: err instanceof Error ? err.name : 'unknown' },
        'event-refund-hold-release-failed: 기한 지난 환급 미룸을 풀지 못했다(집기는 기한으로 판단한다, 다음 틱에 다시 푼다)',
      );
      return;
    }
    for (const r of released) {
      this.deps.log?.error(
        { event: 'event-refund-hold-expired', severity: 'SEV2', eventId: r.eventId, cancellationRequestId: r.cancellationRequestId },
        'event-refund-hold-expired: 회차 취소 요청의 환급 미룸이 72시간 동안 늘려지지 않아 저절로 풀렸다(SEV2)',
      );
    }
  }

  /**
   * 결제사가 환급했는데 REFUNDED 쓰기가 0행이었다. 그 행을 다시 읽어 다른 길(같은 요청 안에서 결제사를 부른 예매 취소·회차 취소 표 취소·
   * 보류 취소 전환)이 먼저 REFUNDED로 끝냈으면 환급으로 센다(true). VOIDED면 이중 처리 위험 SEV1, 그 밖(읽기 실패 포함)은 경고다. 취소 ID만 남긴다
   */
  async #refundedElsewhere(c: DueRefund): Promise<boolean> {
    const sev1 = () =>
      this.deps.log?.error({ event: 'cancellation-refunded-after-void', cancellationId: c.cancellationId }, 'cancellation-refunded-after-void: 무효로 끝난 취소가 결제사에서 환급됐다');
    if (!this.deps.orders) {
      sev1();
      return false;
    }
    let state: string | undefined;
    try {
      state = (await this.deps.orders.findCancellation(c.cancellationId))?.state;
    } catch {
      state = undefined;
    }
    if (state === 'REFUNDED') return true;
    if (state === 'VOIDED') {
      sev1();
      return false;
    }
    this.deps.log?.warn(
      { event: 'cancellation-refund-state-unexpected', cancellationId: c.cancellationId, state: state ?? 'unknown' },
      'cancellation-refund-state-unexpected: 결제사는 환급했는데 환급 상태를 쓰지 못했고 행이 환급·무효가 아니다(다음 틱에 다시 본다)',
    );
    return false;
  }

  /** 보류 취소의 표를 한 틱에 한 번(100장씩) 묻는다. 실패하면 undefined(그 행들을 모두 건너뛴다) */
  async #lookup(held: readonly DueRefund[]): Promise<ReadonlyMap<string, EntryRecordView> | undefined> {
    if (held.length === 0) return new Map();
    const ids = [...new Set(held.flatMap((c) => (c.ticketId !== undefined ? [c.ticketId] : [])))];
    const out = new Map<string, EntryRecordView>();
    try {
      for (let i = 0; i < ids.length; i += ENTRY_LOOKUP_CHUNK) {
        const answer = await this.#entries.lookup(ids.slice(i, i + ENTRY_LOOKUP_CHUNK), ENTRY_LOOKUP_DEADLINE_MS);
        for (const [k, v] of answer) out.set(k, v);
      }
    } catch (err) {
      this.deps.log?.warn(
        { event: 'cancellation-entry-lookup-failed', cancellations: held.length, err: err instanceof Error ? err.name : 'unknown' },
        'cancellation-entry-lookup-failed: 입장 기록을 확인하지 못해 보류 취소를 환급하지 않았다(다음 틱에 다시 묻는다)',
      );
      return undefined;
    }
    return out;
  }

  /**
   * 입장 기록을 남기고(환급 시각을 비운다) 이상 표시 건의 열 대상으로 둔다. 이미 남긴 행이면 false.
   * 다시 열기 포트가 꽂혔으면 건은 틱 끝이 열고(다시 보기 2 N1), 옛 조립만 여기서 한 번 연다(실패하면 경고·지표만, 웨이브 끝 리뷰 S1)
   */
  async #recordEntry(c: DueRefund, record: EntryRecordView): Promise<boolean> {
    const nowMs = this.deps.nowMs();
    const enteredAtMs = record.firstEnteredAtMs ?? nowMs;
    if (!(await this.#claims.markEntryRecorded(c.cancellationId, enteredAtMs, nowMs))) return false;
    if (!this.deps.csOutbox && this.deps.flags) {
      try {
        await this.deps.flags.open({ cancellationId: c.cancellationId, orderId: c.orderId, ticketId: c.ticketId ?? '', enteredAtMs, nowMs });
      } catch (err) {
        this.deps.log?.warn(
          { event: 'cancellation-entry-flag-failed', cancellationId: c.cancellationId, err: err instanceof Error ? err.name : 'unknown' },
          'cancellation-entry-flag-failed: 이상 표시 건을 열지 못했다(행에는 입장 기록이 남음)',
        );
        this.deps.csCaseOpenFailures?.inc('FLAGGED');
      }
    }
    return true;
  }

  /**
   * 옛 조립(다시 열기 포트 없음)만: 실패 표시를 남긴 행의 환급 실패 건을 처리 중에 한 번 연다. 던지면 경고·지표만 남기고 다음 행을 이어 간다
   * (어댑터가 2xx 밖·무응답이면 던진다, 다시 보기 2 N2). 포트가 꽂혔으면 부르지 않는다(틱 끝이 연다)
   */
  async #openRefundFailureNow(q: { cancellationId: string; orderId: string; attempts: number; lastError: string }): Promise<void> {
    if (this.deps.csOutbox || !this.deps.failureNotice) return;
    try {
      await this.deps.failureNotice.open({ ...q, nowMs: this.deps.nowMs() });
    } catch (err) {
      this.deps.log?.warn(
        { event: 'cancellation-refund-failure-notice-failed', cancellationId: q.cancellationId, err: err instanceof Error ? err.name : 'unknown' },
        'cancellation-refund-failure-notice-failed: 환급 실패 CS 건을 열지 못했다(행에는 실패 표시가 남음)',
      );
      this.deps.csCaseOpenFailures?.inc('REFUND_FAILED');
    }
  }

  /**
   * 틱 끝 한 곳의 CS 건 다시 열기(다시 보기 2 N1·N2): 열지 않은 환급 실패 건 → 이상 표시 건 차례로 종류마다 100건 [가정]까지, 한 틱 예산 하나(5초 [가정])와
   * 잇따른 무응답 멈춤(2번 [가정]) 안에서 행마다 따로 연다. ops-svc가 2xx로 받은 행만 연 시각을 쓰고, 실패한 행은 경고·지표 뒤 다음 틱에 다시 연다. 던지지 않는다
   */
  async #reopenCases(): Promise<void> {
    const { csOutbox, failureNotice, flags } = this.deps;
    if (!csOutbox) return;
    const tick = new CsCaseReopenTick({ nowMs: () => this.deps.nowMs(), runner: 'cancellation-refund', signals: this.deps.csCaseOpenFailures, log: this.deps.log });
    if (failureNotice) {
      await tick.reopen({
        kind: 'REFUND_FAILED',
        failedEvent: 'cancellation-refund-failure-notice-failed',
        list: (limit) => csOutbox.pendingRefundFailures(limit),
        open: (row, nowMs) => failureNotice.open({ cancellationId: row.cancellationId, orderId: row.orderId, attempts: row.attempts, lastError: row.lastError, nowMs }),
        markOpened: (row, nowMs) => csOutbox.markRefundFailureOpened(row.cancellationId, nowMs),
        ids: (row) => ({ cancellationId: row.cancellationId }),
      });
    }
    // 환불 대기(REFUND_ACCOUNT_PENDING)는 환급 실패 다음이다(돈을 돌려받지 못한 건 먼저, transfer-refund §3.1 ⑥ 다섯째 종류, BUILD_ORDER GAT-090)
    const accountNotice = this.deps.accountNotice;
    const pendingAccounts = csOutbox.pendingRefundAccounts?.bind(csOutbox);
    const markAccountOpened = csOutbox.markRefundAccountOpened?.bind(csOutbox);
    if (accountNotice && pendingAccounts && markAccountOpened) {
      await tick.reopen({
        kind: 'REFUND_ACCOUNT_PENDING',
        failedEvent: 'cancellation-refund-account-notice-failed',
        list: (limit) => pendingAccounts(limit),
        open: (row, nowMs) => accountNotice.open({ cancellationId: row.cancellationId, orderId: row.orderId, nowMs }),
        markOpened: (row, nowMs) => markAccountOpened(row.cancellationId, nowMs),
        ids: (row) => ({ cancellationId: row.cancellationId }),
      });
    }
    if (flags) {
      await tick.reopen({
        kind: 'FLAGGED',
        failedEvent: 'cancellation-entry-flag-failed',
        list: (limit) => csOutbox.pendingFlags(limit),
        open: (row, nowMs) => flags.open({ cancellationId: row.cancellationId, orderId: row.orderId, ticketId: row.ticketId, enteredAtMs: row.enteredAtMs, nowMs }),
        markOpened: (row, nowMs) => csOutbox.markFlagOpened(row.cancellationId, nowMs),
        ids: (row) => ({ cancellationId: row.cancellationId }),
      });
    }
  }
}

export function refundAfterEntryTask(refund: Pick<RefundAfterEntry, 'run'>, logger?: { warn(o: object, msg: string): void }): MaintenanceTask {
  return {
    name: 'cancellation-refund-retry',
    when: 'daily',
    run: async () => {
      try {
        return await refund.run();
      } catch (err) {
        logger?.warn({ event: 'cancellation_refund_retry_failed', err: (err as Error).name }, '환급 재시도 실행이 실패했다(다음 정비가 다시 한다)');
        throw err;
      }
    },
  };
}
