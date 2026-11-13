// 메모리 티켓 저장소(BUILD_ORDER HOT-160 단위 시험). 운영은 adapters/db/drizzle-ticket-store.ts를 쓴다.
// 같은 주문·세대 발권의 경합을 한 맵으로 모으고, 취소는 티켓별로 한 번만 기록한다.
import type { TicketStore, IssueStoreInput } from '../domain/ports.js';
import {
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type IssueTicketsResult,
  type ListTicketsInput,
  type ListTicketsResult,
  type TicketRecord,
  TicketConflictError,
  walletCursorOf,
  walletTicketOf,
} from '../domain/ticket.js';

interface IssueRecord {
  readonly fingerprint: string;
  readonly tickets: readonly TicketRecord[];
}

const issueKey = (orderId: string, generation: number): string => `${orderId}:${generation}`;
const cancelKey = (cancellationId: string, ticketId: string): string => `${cancellationId}:${ticketId}`;
const withoutKey = (t: TicketRecord): TicketRecord => {
  const { ticketKey: _key, ...rest } = t;
  return rest;
};
const copy = (t: TicketRecord): TicketRecord => ({ ...t });

export class MemoryTicketStore implements TicketStore {
  readonly issues = new Map<string, IssueRecord>();
  readonly tickets = new Map<string, TicketRecord>();
  readonly cancellations = new Map<string, CancelTicketOutcome>();

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
      const outcome = { ticketId, result } as const;
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
    this.tickets.set(t.ticketId, next);
    const issue = this.issues.get(issueKey(t.orderId, t.issueGeneration));
    if (issue) {
      this.issues.set(issueKey(t.orderId, t.issueGeneration), { ...issue, tickets: issue.tickets.map((x) => (x.ticketId === t.ticketId ? next : x)) });
    }
    return started ? 'REFUND_AFTER_CLOSE' : 'REFUND_NOW';
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
