// 메모리 티켓 저장소(BUILD_ORDER HOT-160 단위 시험). 운영은 adapters/db/drizzle-ticket-store.ts를 쓴다.
// 같은 주문·세대 발권의 경합을 한 맵으로 모으고, 취소는 티켓별로 한 번만 기록한다.
import type { TicketStore, IssueStoreInput } from '../domain/ports.js';
import {
  type BlockTicketIssuanceInput,
  type BlockTicketIssuanceResult,
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type EntryRecord,
  type EventCancelInput,
  type EventCancelOutcome,
  EVENT_CANCEL_ENDED_STATUSES,
  type HeldTicket,
  type IssueTicketsResult,
  type ListTicketsInput,
  type ListTicketsResult,
  type OperatorCancelInput,
  type OperatorCancelOutcome,
  operatorCancelResultOf,
  FAN_CANCEL_REASON,
  replayOnlyResultOf,
  type ReviewEligibilityTicket,
  type TicketRecord,
  type TicketStatus,
  TicketConflictError,
  TicketInputError,
  TicketIssueBlockedError,
  walletCursorOf,
  walletTicketOf,
} from '../domain/ticket.js';

interface IssueRecord {
  readonly fingerprint: string;
  readonly tickets: readonly TicketRecord[];
}

const issueKey = (orderId: string, generation: number): string => `${orderId}:${generation}`;
const cancelKey = (cancellationId: string, ticketId: string): string => `${cancellationId}:${ticketId}`;
const operatorKey = (approvalId: string, ticketId: string): string => `${approvalId}:${ticketId}`;
const withoutKey = (t: TicketRecord): TicketRecord => {
  const { ticketKey: _key, ...rest } = t;
  return rest;
};
const copy = (t: TicketRecord): TicketRecord => ({ ...t });

export class MemoryTicketStore implements TicketStore {
  readonly issues = new Map<string, IssueRecord>();
  readonly tickets = new Map<string, TicketRecord>();
  readonly cancellations = new Map<string, CancelTicketOutcome>();
  /** (approval_id, ticket_id) → 운영자 취소 결과(ticket_operator_cancellation) */
  readonly operatorCancellations = new Map<string, OperatorCancelOutcome>();
  /** 표마다 키를 폐기한 팬 취소(ticket_cancellation의 REFUND_NOW·REFUND_AFTER_CLOSE 대역). ALREADY_CANCELLED 답의 첫 칸이다(리뷰 B2) */
  readonly fanCancels = new Map<string, NonNullable<CancelTicketOutcome['first']> & { readonly reason?: string }>();
  /** 들어감·통과 스캔 기록이 있는 표(scan_event IN·PASS의 대역) */
  readonly entries = new Set<string>();
  /** 표마다 스캔 기록(scan_event의 대역: 방향·결과·기기 시각) */
  readonly scans = new Map<string, { direction: 'IN' | 'OUT'; result: 'PASS' | 'REJECT'; atMs: number }[]>();
  /** (cancellation_id, ticket_id) → 회차 취소 결과(ticket_cancellation의 EVENT_CANCELED 대역). 끝낸 표만 남긴다 */
  readonly eventCancellations = new Map<string, EventCancelOutcome>();
  /**
   * 주문별 발권 막기 잠금 자리(ticket_issue_guard의 대역, BAT-011). blockedAtMs가 있으면 막힌 주문이고,
   * 없으면 발권이 먼저 만든 잠금 자리다
   */
  readonly guards = new Map<string, { blockedAtMs?: number; reason?: string }>();

  /**
   * 잠금 뒤에 발권한 표도 잠그는 조회(부정 예매 양도 잠금, ADR-0171). MemoryTransferStore가 꽂는다.
   * 없으면 잠금 없이 발권한다(양도 모듈을 쓰지 않는 단위 시험).
   */
  fraudLockLookup?: (eventId: string, payerAccountId: string, nowMs: number) => { readonly caseId: string; readonly version: number } | undefined;

  async issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult> {
    // 발권 막기와 같은 주문 잠금(운영은 ticket_issue_guard 행). 막힌 주문이면 FAILED_PRECONDITION과 같은 오류다
    const held = this.guards.get(input.orderId);
    if (held?.blockedAtMs !== undefined) throw new TicketIssueBlockedError();
    if (!held) this.guards.set(input.orderId, {});
    const key = issueKey(input.orderId, input.issueGeneration);
    const existing = this.issues.get(key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new TicketConflictError('같은 주문·발권 세대에 다른 내용으로 다시 발권할 수 없다');
      return { tickets: existing.tickets.map(withoutKey), replayed: true };
    }
    // 잠금이 걸린 계정이 그 회차 표를 새로 사면 발권 때 잠근다(R-T31 ⑬)
    const lock = this.fraudLockLookup?.(input.eventId, input.payerAccountId, input.nowMs ?? Date.now());
    const saved = candidates.map((c) => copy(lock ? { ...c, fraudLockCaseId: lock.caseId, fraudLockVersion: lock.version } : c));
    this.issues.set(key, { fingerprint: input.fingerprint, tickets: saved });
    for (const t of saved) this.tickets.set(t.ticketId, t);
    return { tickets: saved, replayed: false };
  }

  async cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]> {
    // 확인만(replayOnly): 행·취소 기록을 바꾸지 않고 같은 취소 ID의 기록도 보지 않는다(리뷰 B2 보충)
    if (input.replayOnly) {
      return input.ticketIds.map((ticketId) => {
        const result = replayOnlyResultOf(this.tickets.get(ticketId), input);
        const first = result === 'ALREADY_CANCELLED' ? this.#firstFanCancel(ticketId) : undefined;
        return { ticketId, result, ...(first ? { first } : {}) };
      });
    }
    const out: CancelTicketOutcome[] = [];
    for (const ticketId of input.ticketIds) {
      const recorded = this.cancellations.get(cancelKey(input.cancellationId, ticketId));
      if (recorded) {
        out.push(recorded);
        continue;
      }
      const t = this.tickets.get(ticketId);
      const result = this.#cancelOne(input, t);
      const first = result === 'ALREADY_CANCELLED' ? this.#firstFanCancel(ticketId) : undefined;
      const outcome: CancelTicketOutcome = { ticketId, result, ...(first ? { first } : {}) };
      this.cancellations.set(cancelKey(input.cancellationId, ticketId), outcome);
      out.push(outcome);
    }
    return out;
  }

  #cancelOne(input: CancelTicketsInput, t: TicketRecord | undefined): CancelTicketOutcome['result'] {
    if (!t || t.orderId !== input.orderId) return 'NOT_PAYER_HOLDER';
    if (t.accountId !== input.requestedByAccountId || t.payerAccountId !== input.requestedByAccountId) return 'NOT_PAYER_HOLDER';
    if (t.status === 'TRANSFER_PENDING' || t.transferPending) return 'TRANSFER_PENDING';
    if (t.status === 'REFUNDED' || t.status === 'VOIDED' || t.status === 'CANCEL_REQUESTED' || t.status === 'FLAGGED') return 'ALREADY_CANCELLED';
    const started = t.eventStartsAtMs !== undefined && input.nowMs >= t.eventStartsAtMs;
    const next: TicketRecord = {
      ...t,
      status: started ? 'VOIDED' : 'REFUNDED',
      keyRevokedAtMs: input.nowMs,
      version: t.version + 1,
    };
    this.#put(next);
    const result = started ? 'REFUND_AFTER_CLOSE' : 'REFUND_NOW';
    this.fanCancels.set(t.ticketId, { cancellationId: input.cancellationId, result, cancelledAtMs: input.nowMs, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    return result;
  }

  /**
   * 주문 단위 발권 막기(BAT-011, ticket_issue_guard의 대역). 주문 ID로 멱등하고, 아직 VOIDED·REFUNDED가 아닌 티켓을 VOIDED로 바꾼다.
   * alreadyEntered는 그 주문의 티켓 가운데 입장 기록(IN·PASS)이 있는 수다(표마다 하나)
   */
  async blockIssue(input: BlockTicketIssuanceInput): Promise<BlockTicketIssuanceResult> {
    const held = this.guards.get(input.orderId);
    if (!held) this.guards.set(input.orderId, { blockedAtMs: input.nowMs, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
    else if (held.blockedAtMs === undefined) {
      held.blockedAtMs = input.nowMs;
      if (input.reason !== undefined) held.reason = input.reason;
    }
    let voided = 0;
    for (const t of [...this.tickets.values()].filter((x) => x.orderId === input.orderId).sort((a, b) => a.ticketId.localeCompare(b.ticketId))) {
      if (t.status === 'VOIDED' || t.status === 'REFUNDED') continue;
      this.#put({ ...t, status: 'VOIDED', keyRevokedAtMs: input.nowMs, version: t.version + 1 });
      voided += 1;
    }
    const alreadyEntered = [...this.tickets.values()].filter((t) => t.orderId === input.orderId && this.entries.has(t.ticketId)).length;
    return { voided, alreadyEntered };
  }

  /** 그 표를 끝낸 취소 기록이 팬 취소(사유 USER)일 때만 첫 칸(다시 보기 R1) */
  #firstFanCancel(ticketId: string): CancelTicketOutcome['first'] {
    const rec = this.fanCancels.get(ticketId);
    return rec && rec.reason === FAN_CANCEL_REASON ? { cancellationId: rec.cancellationId, result: rec.result, cancelledAtMs: rec.cancelledAtMs } : undefined;
  }

  /** 티켓 행과 발권 기록의 사본을 함께 바꾼다 */
  #put(next: TicketRecord): void {
    this.tickets.set(next.ticketId, next);
    const issue = this.issues.get(issueKey(next.orderId, next.issueGeneration));
    if (issue) {
      this.issues.set(issueKey(next.orderId, next.issueGeneration), { ...issue, tickets: issue.tickets.map((x) => (x.ticketId === next.ticketId ? next : x)) });
    }
  }

  /**
   * 부정 예매 운영자 취소(BAT-415 몫 F). 없는 표·다른 회차 표가 하나라도 있으면 아무것도 바꾸지 않고 던진다(DB 트랜잭션째 되돌림과 같다).
   * (approval_id, ticket_id) 기록이 있으면 그 결과를 준다. 건너뜀도 기록한다
   */
  async operatorCancel(input: OperatorCancelInput): Promise<readonly OperatorCancelOutcome[]> {
    for (const target of input.targets) {
      const t = this.tickets.get(target.ticketId);
      if (!t || t.eventId !== input.eventId) throw new TicketInputError('없는 표이거나 다른 회차의 표다');
    }
    return input.targets.map((target) => {
      const recorded = this.operatorCancellations.get(operatorKey(input.approvalId, target.ticketId));
      if (recorded) return recorded;
      const t = this.tickets.get(target.ticketId)!;
      const result = operatorCancelResultOf(t, this.entries.has(t.ticketId), target.expectedHolderAccountId);
      if (result === 'CANCELED') this.#put({ ...t, status: 'REFUNDED', transferPending: false, keyRevokedAtMs: input.nowMs, version: t.version + 1 });
      const outcome: OperatorCancelOutcome = { ticketId: t.ticketId, result, orderId: t.orderId };
      this.operatorCancellations.set(operatorKey(input.approvalId, target.ticketId), outcome);
      return outcome;
    });
  }

  /**
   * 회차 취소 표 끝내기(BAT-420 GAT-110 E). 없는 표·다른 회차 표가 하나라도 있으면 아무것도 바꾸지 않고 던진다(DB 트랜잭션째 되돌림과 같다).
   * (cancellation_id, ticket_id) 기록이 있으면 처음 결과를 준다. 환급·무효인 표는 그대로 두고 기록하지 않는다
   */
  async eventCancel(input: EventCancelInput): Promise<readonly EventCancelOutcome[]> {
    for (const target of input.targets) {
      const t = this.tickets.get(target.ticketId);
      if (!t || t.eventId !== input.eventId) throw new TicketInputError('없는 표이거나 다른 회차의 표다');
    }
    return input.targets.map((target) => {
      const recorded = this.eventCancellations.get(cancelKey(target.cancellationId, target.ticketId));
      if (recorded) return recorded;
      const t = this.tickets.get(target.ticketId)!;
      if (EVENT_CANCEL_ENDED_STATUSES.has(t.status)) return { ticketId: t.ticketId, result: 'ALREADY_ENDED', orderId: t.orderId, holderAccountId: t.accountId, transferWithdrawn: false };
      const transferWithdrawn = t.transferPending || t.status === 'TRANSFER_PENDING';
      this.#put({ ...t, status: 'REFUNDED', transferPending: false, keyRevokedAtMs: input.nowMs, version: t.version + 1 });
      const outcome: EventCancelOutcome = { ticketId: t.ticketId, result: 'CANCELED', orderId: t.orderId, holderAccountId: t.accountId, transferWithdrawn };
      this.eventCancellations.set(cancelKey(target.cancellationId, target.ticketId), outcome);
      return outcome;
    });
  }

  /** 입장 기록 대조(BAT-420 GAT-090 A): 들어감(IN)·통과(PASS) 스캔만 입장으로 센다. 읽기만, 요청 차례 */
  async entryRecords(ticketIds: readonly string[]): Promise<readonly EntryRecord[]> {
    return ticketIds.map((ticketId) => {
      if (!this.tickets.has(ticketId)) return { ticketId, found: false, entered: false };
      const passes = (this.scans.get(ticketId) ?? []).filter((s) => s.direction === 'IN' && s.result === 'PASS').map((s) => s.atMs);
      if (passes.length === 0) return { ticketId, found: true, entered: false };
      return { ticketId, found: true, entered: true, firstEnteredAtMs: Math.min(...passes) };
    });
  }

  /** 시험 씨앗(BAT-420 GAT-090 A): 그 표에 스캔 한 건(방향·결과·시각)을 남긴다(scan_event의 대역). 들어감·통과면 운영자 취소의 입장 기록도 된다 */
  recordScan(ticketId: string, direction: 'IN' | 'OUT', result: 'PASS' | 'REJECT', atMs: number): void {
    this.scans.set(ticketId, [...(this.scans.get(ticketId) ?? []), { direction, result, atMs }]);
    if (direction === 'IN' && result === 'PASS') this.entries.add(ticketId);
  }

  /** 시험 씨앗: 그 표에 들어감(IN)·통과(PASS) 스캔 기록이 있는 것으로 둔다(운영자 취소의 SKIPPED_ENTRY_RECORDED) */
  recordEntry(ticketId: string): void {
    this.entries.add(ticketId);
  }

  async listReviewEligibility(eventId: string): Promise<readonly ReviewEligibilityTicket[]> {
    return [...this.tickets.values()]
      .filter((t) => t.eventId === eventId)
      .map((t) => ({ accountId: t.accountId, payerAccountId: t.payerAccountId, orderId: t.orderId, status: t.status, issuedAtMs: t.issuedAtMs }));
  }

  async listHeld(accountId: string, eventId: string, statuses: readonly TicketStatus[]): Promise<readonly HeldTicket[]> {
    return [...this.tickets.values()]
      .filter((t) => t.accountId === accountId && t.eventId === eventId && statuses.includes(t.status))
      .sort((a, b) => a.ticketId.localeCompare(b.ticketId))
      .map((t) => ({ ticketId: t.ticketId, status: t.status }));
  }

  async list(input: ListTicketsInput): Promise<ListTicketsResult> {
    const all = [...this.tickets.values()]
      .filter((t) => t.accountId === input.accountId)
      .sort((a, b) => b.issuedAtMs - a.issuedAtMs || b.ticketId.localeCompare(a.ticketId));
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const after = cursor ? all.filter((t) => t.issuedAtMs < cursor.issuedAtMs || (t.issuedAtMs === cursor.issuedAtMs && t.ticketId < cursor.ticketId)) : all;
    const page = after.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor = after.length > input.limit && last ? walletCursorOf({ issuedAtMs: last.issuedAtMs, ticketId: last.ticketId }) : undefined;
    return { tickets: page.map(walletTicketOf), ...(nextCursor ? { nextCursor } : {}) };
  }
}

function decodeCursor(raw: string): { issuedAtMs: number; ticketId: string } | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'string') return undefined;
    return { issuedAtMs: v[0], ticketId: v[1] };
  } catch {
    return undefined;
  }
}
