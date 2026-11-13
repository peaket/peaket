// 운영 티켓 저장소(BUILD_ORDER HOT-160). 발권은 (order_id, issue_generation) PK의 INSERT 경합으로 한 번만 만들고,
// 취소는 티켓 행 FOR UPDATE 안에서 조건을 보고 (cancellation_id, ticket_id) 취소표를 남긴다.
import type { Database, DbTransaction } from '@peaket/platform';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { IssueStoreInput, TicketStore } from '../../domain/ports.js';
import {
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type IssueTicketsResult,
  type ListTicketsInput,
  type ListTicketsResult,
  type ReviewEligibilityTicket,
  type TicketRecord,
  TicketConflictError,
  type TicketStatus,
  walletCursorOf,
  walletTicketOf,
} from '../../domain/ticket.js';
import { ticket, ticketCancellation, ticketIssue } from './schema.js';

export interface DrizzleTicketStoreOptions {
  readonly database: Database;
}

const statusOf = (v: string): TicketStatus => {
  if (v === 'ISSUED' || v === 'ACTIVE' || v === 'TRANSFER_PENDING' || v === 'CANCEL_REQUESTED' || v === 'REFUNDED' || v === 'FLAGGED' || v === 'VOIDED') return v;
  throw new Error(`알 수 없는 티켓 상태: ${v}`);
};

type Row = typeof ticket.$inferSelect;

const recordOf = (r: Row): TicketRecord => ({
  ticketId: r.id,
  accountId: r.accountId,
  payerAccountId: r.payerAccountId,
  orderId: r.orderId,
  eventId: r.eventId,
  seatId: r.seatId,
  gateZone: r.gateZone,
  status: statusOf(r.status),
  issueGeneration: Number(r.issueGeneration),
  qrPayload: r.qrPayload,
  keyHash: r.keyHash,
  ...(r.keyRevokedAt ? { keyRevokedAtMs: r.keyRevokedAt.getTime() } : {}),
  transferPending: r.transferPending,
  ...(r.fraudLockCaseId ? { fraudLockCaseId: r.fraudLockCaseId } : {}),
  version: r.version,
  issuedAtMs: r.createdAt.getTime(),
  ...(r.eventStartsAt ? { eventStartsAtMs: r.eventStartsAt.getTime() } : {}),
});

const valuesOf = (t: TicketRecord) => ({
  id: t.ticketId,
  accountId: t.accountId,
  payerAccountId: t.payerAccountId,
  orderId: t.orderId,
  eventId: t.eventId,
  seatId: t.seatId,
  gateZone: t.gateZone,
  status: t.status,
  issueGeneration: t.issueGeneration,
  qrPayload: t.qrPayload,
  keyHash: t.keyHash,
  transferPending: t.transferPending,
  version: t.version,
  eventStartsAt: t.eventStartsAtMs === undefined ? null : new Date(t.eventStartsAtMs),
  createdAt: new Date(t.issuedAtMs),
});

export class DrizzleTicketStore implements TicketStore {
  constructor(private readonly o: DrizzleTicketStoreOptions) {}

  async issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult> {
    return this.o.database.transaction(async (tx) => {
      const inserted = await tx
        .insert(ticketIssue)
        .values({
          orderId: input.orderId,
          issueGeneration: input.issueGeneration,
          eventId: input.eventId,
          payerAccountId: input.payerAccountId,
          fingerprint: input.fingerprint,
        })
        .onConflictDoNothing({ target: [ticketIssue.orderId, ticketIssue.issueGeneration] })
        .returning({ orderId: ticketIssue.orderId });
      if (inserted.length === 0) {
        const existing = await tx
          .select()
          .from(ticketIssue)
          .where(and(eq(ticketIssue.orderId, input.orderId), eq(ticketIssue.issueGeneration, input.issueGeneration)))
          .limit(1);
        if (existing[0]?.fingerprint !== input.fingerprint) throw new TicketConflictError('같은 주문·발권 세대에 다른 내용으로 다시 발권할 수 없다');
        const rows = await tx
          .select()
          .from(ticket)
          .where(and(eq(ticket.orderId, input.orderId), eq(ticket.issueGeneration, input.issueGeneration)))
          .orderBy(ticket.seatId);
        return { tickets: rows.map(recordOf), replayed: true };
      }
      await tx.insert(ticket).values(candidates.map(valuesOf));
      return { tickets: candidates, replayed: false };
    });
  }

  async cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]> {
    return this.o.database.transaction(async (tx) => {
      const out: CancelTicketOutcome[] = [];
      for (const ticketId of input.ticketIds) {
        const recorded = await tx
          .select({ result: ticketCancellation.result })
          .from(ticketCancellation)
          .where(and(eq(ticketCancellation.cancellationId, input.cancellationId), eq(ticketCancellation.ticketId, ticketId)))
          .limit(1);
        if (recorded[0]) {
          out.push({ ticketId, result: recorded[0].result as CancelTicketOutcome['result'] });
          continue;
        }
        const rows = await tx.select().from(ticket).where(eq(ticket.id, ticketId)).limit(1).for('update');
        // 같은 cancellation_id가 동시에 들어오면 행 잠금을 기다린 뒤 취소표를 다시 본다(멱등 결과 보존).
        const afterLock = await tx
          .select({ result: ticketCancellation.result })
          .from(ticketCancellation)
          .where(and(eq(ticketCancellation.cancellationId, input.cancellationId), eq(ticketCancellation.ticketId, ticketId)))
          .limit(1);
        if (afterLock[0]) {
          out.push({ ticketId, result: afterLock[0].result as CancelTicketOutcome['result'] });
          continue;
        }
        const result = this.#cancelOne(tx, input, rows[0], ticketId);
        out.push({ ticketId, result: await result });
      }
      return out;
    });
  }

  async #cancelOne(tx: DbTransaction, input: CancelTicketsInput, row: Row | undefined, ticketId: string): Promise<CancelTicketOutcome['result']> {
    if (!row || row.orderId !== input.orderId) return 'NOT_PAYER_HOLDER';
    if (row.accountId !== input.requestedByAccountId || row.payerAccountId !== input.requestedByAccountId) return 'NOT_PAYER_HOLDER';
    if (row.status === 'TRANSFER_PENDING' || row.transferPending) return 'TRANSFER_PENDING';
    if (row.status === 'REFUNDED' || row.status === 'VOIDED' || row.status === 'CANCEL_REQUESTED' || row.status === 'FLAGGED') return 'ALREADY_CANCELLED';
    const started = row.eventStartsAt !== null && input.nowMs >= row.eventStartsAt.getTime();
    const status: TicketStatus = started ? 'VOIDED' : 'REFUNDED';
    const result: CancelTicketOutcome['result'] = started ? 'REFUND_AFTER_CLOSE' : 'REFUND_NOW';
    await tx
      .update(ticket)
      .set({ status, keyRevokedAt: new Date(input.nowMs), version: row.version + 1 })
      .where(eq(ticket.id, ticketId));
    await tx.insert(ticketCancellation).values({
      cancellationId: input.cancellationId,
      ticketId,
      orderId: input.orderId,
      result,
      cancelledAt: new Date(input.nowMs),
    });
    return result;
  }

  async listReviewEligibility(eventId: string): Promise<readonly ReviewEligibilityTicket[]> {
    const rows = await this.o.database.db
      .select({ accountId: ticket.accountId, payerAccountId: ticket.payerAccountId, orderId: ticket.orderId, status: ticket.status, createdAt: ticket.createdAt })
      .from(ticket)
      .where(eq(ticket.eventId, eventId));
    return rows.map((r) => ({ accountId: r.accountId, payerAccountId: r.payerAccountId, orderId: r.orderId, status: statusOf(r.status), issuedAtMs: r.createdAt.getTime() }));
  }

  async list(input: ListTicketsInput): Promise<ListTicketsResult> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const where = cursor
      ? and(
          eq(ticket.accountId, input.accountId),
          or(lt(ticket.createdAt, new Date(cursor.issuedAtMs)), and(eq(ticket.createdAt, new Date(cursor.issuedAtMs)), lt(ticket.id, cursor.ticketId))),
        )
      : eq(ticket.accountId, input.accountId);
    const rows = await this.o.database.db
      .select()
      .from(ticket)
      .where(where)
      .orderBy(desc(ticket.createdAt), desc(ticket.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > input.limit && last ? walletCursorOf({ issuedAtMs: last.createdAt.getTime(), ticketId: last.id }) : undefined;
    return { tickets: page.map((r) => walletTicketOf(recordOf(r))), ...(nextCursor ? { nextCursor } : {}) };
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
