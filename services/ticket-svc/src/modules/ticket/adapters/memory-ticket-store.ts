// 메모리 티켓 저장소(BUILD_ORDER HOT-160 단위 시험). 운영은 adapters/db/drizzle-ticket-store.ts를 쓴다.
// 같은 주문·세대 발권의 경합을 한 맵으로 모으고, 취소는 티켓별로 한 번만 기록한다.
import type { TicketStore, IssueStoreInput } from '../domain/ports.js';
import {
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type EntryRecord,
  type EventCancelInput,
  type EventCancelOutcome,
  type IssueTicketsResult,
  type ListTicketsInput,
  type ListTicketsResult,
  type OperatorCancelInput,
  type OperatorCancelOutcome,
  operatorCancelResultOf,
  type ReviewEligibilityTicket,
  type TicketRecord,
  TicketConflictError,
  TicketInputError,
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
  readonly fanCancels = new Map<string, NonNullable<CancelTicketOutcome['first']>>();
  /** 들어감·통과 스캔 기록이 있는 표(scan_event IN·PASS의 대역) */
  readonly entries = new Set<string>();

  async issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult> {
    const key = issueKey(input.orderId, input.issueGeneration);
    const existing = this.issues.get(key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new TicketConflictError('같은 주문·발권 세대에 다른 내용으로 다시 발권할 수 없다');
      return { tickets: existing.tickets.map(withoutKey), replayed: true };
    }
    const saved = candidates.map(copy);
    this.issues.set(key, { fingerprint: input.fingerprint, tickets: saved });
    for (const t of saved) this.tickets.set(t.ticketId, t);
    return { tickets: saved, replayed: false };
  }

  async cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]> {
    const out: CancelTicketOutcome[] = [];
    for (const ticketId of input.ticketIds) {
      const recorded = this.cancellations.get(cancelKey(input.cancellationId, ticketId));
      if (recorded) {
        out.push(recorded);
        continue;
      }
      const t = this.tickets.get(ticketId);
      const result = this.#cancelOne(input, t);
      const first = result === 'ALREADY_CANCELLED' ? this.fanCancels.get(ticketId) : undefined;
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
    this.fanCancels.set(t.ticketId, { cancellationId: input.cancellationId, result, cancelledAtMs: input.nowMs });
    return result;
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

  /** 회차 취소 표 끝내기(BAT-420 GAT-110 E, 빈 뼈대) */
  async eventCancel(_input: EventCancelInput): Promise<readonly EventCancelOutcome[]> {
    throw new Error('아직 없음');
  }

  /** 입장 기록 대조(BAT-420 GAT-090 A, 빈 뼈대) */
  async entryRecords(_ticketIds: readonly string[]): Promise<readonly EntryRecord[]> {
    throw new Error('아직 없음');
  }

  /** 시험 씨앗(BAT-420 GAT-090 A, 빈 뼈대): 그 표에 스캔 한 건(방향·결과·시각)을 남긴다(scan_event의 대역) */
  recordScan(_ticketId: string, _direction: 'IN' | 'OUT', _result: 'PASS' | 'REJECT', _atMs: number): void {
    throw new Error('아직 없음');
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
