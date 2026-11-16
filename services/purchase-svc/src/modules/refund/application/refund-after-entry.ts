// 환급 실행기(GAT-080·GAT-090, docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1·§7.1).
// ① 입장 기록 마감 뒤 환급할 REQUESTED(refund_due_at이 지난 것) ② 결제사 결과 모름·일시 실패로 남은 REFUND_PENDING(next_refund_at이 지난 것)을
// 같은 결제사 취소(cancel-{cancellationId})로 이어 간다. 성공하면 REFUNDED, 업무 거절·재시도 소진이면 refund_failed_at을 남겨 CS 처리함 대상으로 보낸다.
// ①은 결제사로 보내기 전에 ticket-svc 입장 기록(GetEntryRecords)을 본다(BAT-420 GAT-090, '입장 기록 대조와 환급 집기'):
//   들어감·통과 기록이 있으면 환급하지 않고 가장 이른 입장 시각을 남겨 CS '이상 표시'를 열고, 모르면(조회 실패·표 없음) 이번 틱은 건너뛰며,
//   없으면 조건부로 집은(REQUESTED → REFUND_PENDING) 뒤에만 결제사를 부른다. 상태 쓰기는 REFUND_PENDING 행에만 해 그사이 무효를 덮지 않는다.
// 카드 결제는 계좌가 필요 없고, 가상계좌는 환불 계좌를 저장하지 않으므로(POL-014) 이 실행기가 처리하지 못한다(CS 알림 대상).
import type { MaintenanceTask } from '@peaket/platform';
import { REFUND_RETRY_MAX_ATTEMPTS, refundRetryDelayMs, type DueRefund } from '../domain/cancellation.js';
import type { EventRefundHolds } from '../domain/event-refund-ports.js';
import { ENTRY_LOOKUP_DEADLINE_MS, type CancellationClaims, type CancellationWrites, type EntryFlagNotice, type EntryRecords, type EntryRecordView, type PaymentCancellations, type RefundFailureNotice } from '../domain/ports.js';

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
  /** BAT-420 몫 D(빈 뼈대, 아직 쓰지 않는다): 기한이 지난 미룸 풀기. 틱 맨 앞에 부르고 풀린 줄마다 SEV2 로그를 남긴다 */
  holds?: Pick<EventRefundHolds, 'releaseExpired'>;
}

/** 한 번에 처리하는 취소 수 [가정] */
export const REFUND_AFTER_ENTRY_BATCH = 100;
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
}

export class RefundAfterEntry {
  readonly #entries: EntryRecords;
  readonly #claims: CancellationClaims;

  constructor(private readonly deps: RefundAfterEntryDeps) {
    if (!deps.entries || !deps.claims) throw new Error('환급 실행기에 입장 기록 대조(entries)·조건부 집기(claims)를 꽂아야 한다(BAT-420 GAT-090 A6)');
    this.#entries = deps.entries;
    this.#claims = deps.claims;
  }

  async run(limit = REFUND_AFTER_ENTRY_BATCH): Promise<RefundAfterEntryResult> {
    const due = await this.deps.writes.dueRefunds(this.deps.nowMs(), limit);
    let refunded = 0;
    let pending = 0;
    let failed = 0;
    let entryRecorded = 0;
    let unverified = 0;
    const records = await this.#lookup(due.filter((c) => c.status === 'REQUESTED'));
    for (const c of due) {
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
      const r = await this.deps.payments.cancel({ cancellationId: c.cancellationId, orderId: c.orderId, amount: c.amount, reason: c.reason, deadlineMs: 5_000 });
      if (r === 'CANCELLED') {
        const applied = await this.deps.writes.updateStatus({ cancellationId: c.cancellationId, status: 'REFUNDED', nowMs: this.deps.nowMs() });
        if (applied === false) {
          // 결제사는 환급했는데 그사이 취소가 무효로 끝났다(CS가 확인해야 하는 이중 처리 위험, SEV1). 취소 ID만 남긴다
          this.deps.log?.error({ event: 'cancellation-refunded-after-void', cancellationId: c.cancellationId }, 'cancellation-refunded-after-void: 무효로 끝난 취소가 결제사에서 환급됐다');
          continue;
        }
        refunded++;
        continue;
      }
      const attempts = c.attempts + 1;
      if (r === 'REJECTED' || attempts >= REFUND_RETRY_MAX_ATTEMPTS) {
        const marked = await this.deps.writes.markRefundFailed({ cancellationId: c.cancellationId, attempts, lastError: r, nowMs: this.deps.nowMs() });
        if (marked === false) continue;
        await this.deps.failureNotice?.open({ cancellationId: c.cancellationId, orderId: c.orderId, attempts, lastError: r, nowMs: this.deps.nowMs() });
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
    return { refunded, pending, failed, entryRecorded, unverified };
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

  /** 입장 기록을 남기고(환급 시각을 비운다) CS '이상 표시'를 연다(best effort). 이미 남긴 행이면 false */
  async #recordEntry(c: DueRefund, record: EntryRecordView): Promise<boolean> {
    const nowMs = this.deps.nowMs();
    const enteredAtMs = record.firstEnteredAtMs ?? nowMs;
    if (!(await this.#claims.markEntryRecorded(c.cancellationId, enteredAtMs, nowMs))) return false;
    try {
      await this.deps.flags?.open({ cancellationId: c.cancellationId, orderId: c.orderId, ticketId: c.ticketId ?? '', enteredAtMs, nowMs });
    } catch (err) {
      this.deps.log?.warn({ event: 'cancellation-entry-flag-failed', cancellationId: c.cancellationId, err: err instanceof Error ? err.name : 'unknown' }, '이상 표시 건을 열지 못했다');
    }
    return true;
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
