// 운영 티켓 저장소(BUILD_ORDER HOT-160). 발권은 (order_id, issue_generation) PK의 INSERT 경합으로 한 번만 만들고,
// 취소는 티켓 행 FOR UPDATE 안에서 조건을 보고 (cancellation_id, ticket_id) 취소표를 남긴다.
import type { Database, DbTransaction } from '@peaket/platform';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { IssueStoreInput, TicketStore } from '../../domain/ports.js';
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
  type OperatorCancelResult,
  operatorCancelResultOf,
  replayOnlyResultOf,
  type ReviewEligibilityTicket,
  type TicketRecord,
  TicketConflictError,
  TicketInputError,
  type TicketStatus,
  walletCursorOf,
  walletTicketOf,
} from '../../domain/ticket.js';
import { ticket, ticketCancellation, ticketIssue, ticketOperatorCancellation } from './schema.js';

/** 발권·취소와 같은 트랜잭션에 스캐너 변경 기록을 넣는 포트(offline-gate §6.3) */
export interface ScannerChangeWriter {
  append(tx: DbTransaction, eventId: string, kind: string, payload: Record<string, unknown>): Promise<number>;
}

/** 취소 트랜잭션 안에서 그 티켓의 유효 기기 키를 폐기하는 포트(GAT-140) */
export interface DeviceKeyRevoker {
  revokeActiveInTx(tx: DbTransaction, ticketId: string, nowMs: number): Promise<Uint8Array | undefined>;
}

export interface DrizzleTicketStoreOptions {
  readonly database: Database;
  /** 없으면 변경 기록을 남기지 않는다(단위 시험·구성 전) */
  readonly changes?: ScannerChangeWriter;
  /** 없으면 기기 키를 폐기하지 않는다(단위 시험·구성 전) */
  readonly deviceKeys?: DeviceKeyRevoker;
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
      if (this.o.changes) {
        for (const t of candidates) {
          await this.o.changes.append(tx, input.eventId, 'TICKET_STATUS', { v: 1, ticketId: t.ticketId, status: t.status, version: t.version });
        }
      }
      return { tickets: candidates, replayed: false };
    });
  }

  async cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]> {
    // 확인만(replayOnly): 행을 잠그거나 바꾸지 않고 같은 취소 ID의 기록도 보지 않는다. 끝난 표는 팬 취소 기록을 첫 칸으로 싣는다(리뷰 B2 보충)
    if (input.replayOnly) {
      return this.o.database.transaction(async (tx) => {
        const out: CancelTicketOutcome[] = [];
        for (const ticketId of input.ticketIds) {
          const [row] = await tx.select().from(ticket).where(eq(ticket.id, ticketId)).limit(1);
          const result = replayOnlyResultOf(row ? { orderId: row.orderId, payerAccountId: row.payerAccountId, status: statusOf(row.status) } : undefined, input);
          const first = result === 'ALREADY_CANCELLED' ? await this.#firstFanCancel(tx, ticketId) : undefined;
          out.push({ ticketId, result, ...(first ? { first } : {}) });
        }
        return out;
      });
    }
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
        const result = await this.#cancelOne(tx, input, rows[0], ticketId);
        const first = result === 'ALREADY_CANCELLED' ? await this.#firstFanCancel(tx, ticketId) : undefined;
        out.push({ ticketId, result, ...(first ? { first } : {}) });
      }
      return out;
    });
  }

  /**
   * 그 표의 키를 폐기한 팬 취소(ticket_cancellation의 REFUND_NOW·REFUND_AFTER_CLOSE, 가장 이른 것). 운영자 취소·무효로 끝난 표는 없다(리뷰 B2,
   * docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기'). ALREADY_CANCELLED는 ticket_cancellation에 남기지 않으므로 첫 취소가 아니다
   */
  async #firstFanCancel(tx: DbTransaction, ticketId: string): Promise<CancelTicketOutcome['first']> {
    const [row] = await tx
      .select({ cancellationId: ticketCancellation.cancellationId, result: ticketCancellation.result, cancelledAt: ticketCancellation.cancelledAt })
      .from(ticketCancellation)
      .where(and(eq(ticketCancellation.ticketId, ticketId), inArray(ticketCancellation.result, ['REFUND_NOW', 'REFUND_AFTER_CLOSE'])))
      .orderBy(asc(ticketCancellation.cancelledAt), asc(ticketCancellation.cancellationId))
      .limit(1);
    if (!row || (row.result !== 'REFUND_NOW' && row.result !== 'REFUND_AFTER_CLOSE')) return undefined;
    return { cancellationId: row.cancellationId, result: row.result, cancelledAtMs: row.cancelledAt.getTime() };
  }

  async #cancelOne(tx: DbTransaction, input: CancelTicketsInput, row: Row | undefined, ticketId: string): Promise<CancelTicketOutcome['result']> {
    if (!row || row.orderId !== input.orderId) return 'NOT_PAYER_HOLDER';
    if (row.accountId !== input.requestedByAccountId || row.payerAccountId !== input.requestedByAccountId) return 'NOT_PAYER_HOLDER';
    if (row.status === 'TRANSFER_PENDING' || row.transferPending) return 'TRANSFER_PENDING';
    if (row.status === 'REFUNDED' || row.status === 'VOIDED' || row.status === 'CANCEL_REQUESTED' || row.status === 'FLAGGED') return 'ALREADY_CANCELLED';
    const started = row.eventStartsAt !== null && input.nowMs >= row.eventStartsAt.getTime();
    const status: TicketStatus = started ? 'VOIDED' : 'REFUNDED';
    const result: CancelTicketOutcome['result'] = started ? 'REFUND_AFTER_CLOSE' : 'REFUND_NOW';
    const revokedKeyId = await this.o.deviceKeys?.revokeActiveInTx(tx, ticketId, input.nowMs);
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
    if (this.o.changes) {
      await this.o.changes.append(tx, row.eventId, 'TICKET_STATUS', { v: 1, ticketId, status, version: row.version + 1 });
      await this.o.changes.append(tx, row.eventId, 'KEY_REVOKED', { v: 1, ticketId, keyId: revokedKeyId ? Buffer.from(revokedKeyId).toString('base64url') : null });
    }
    return result;
  }

  /**
   * 부정 예매 운영자 취소(BAT-415 몫 F, 0008 ticket_operator_cancellation, docs/features/transfer-refund.md §7.4).
   * 한 트랜잭션에서 대상 표의 행을 모두 잠그고(FOR UPDATE, 표 ID 차례) 요청 차례로 가른다. 없는 표·다른 회차 표를 만나면 TicketInputError를 던져
   * 앞 표의 변경까지 트랜잭션째 되돌린다. (approval_id, ticket_id) 기록이 있으면 처음 결과를 그대로 준다(잠금 뒤 다시 본다).
   * 팬 취소(cancel)와 같은 행 잠금을 잡으므로 같은 표를 동시에 노려도 하나만 키를 폐기한다
   */
  async operatorCancel(input: OperatorCancelInput): Promise<readonly OperatorCancelOutcome[]> {
    return this.o.database.transaction(async (tx) => {
      // 잠금은 표 ID 차례로 한 번에 잡는다(다른 차례로 겹친 요청과 교착하지 않게). 결과는 요청 차례다
      const locked = await tx
        .select()
        .from(ticket)
        .where(inArray(ticket.id, input.targets.map((t) => t.ticketId)))
        .orderBy(ticket.id)
        .for('update');
      const byId = new Map(locked.map((r) => [r.id, r]));
      const out: OperatorCancelOutcome[] = [];
      for (const target of input.targets) {
        const row = byId.get(target.ticketId);
        if (!row || row.eventId !== input.eventId) throw new TicketInputError('없는 표이거나 다른 회차의 표다');
        const recorded = await tx
          .select({ result: ticketOperatorCancellation.result, orderId: ticketOperatorCancellation.orderId, withdrawn: ticketOperatorCancellation.withdrawnTransferOfferId })
          .from(ticketOperatorCancellation)
          .where(and(eq(ticketOperatorCancellation.approvalId, input.approvalId), eq(ticketOperatorCancellation.ticketId, target.ticketId)))
          .limit(1);
        if (recorded[0]) {
          out.push({ ticketId: target.ticketId, result: recorded[0].result as OperatorCancelResult, orderId: recorded[0].orderId, ...(recorded[0].withdrawn ? { withdrawnTransferOfferId: recorded[0].withdrawn } : {}) });
          continue;
        }
        const result = operatorCancelResultOf({ status: statusOf(row.status), accountId: row.accountId }, await this.#entryRecorded(tx, row.eventId, row.id), target.expectedHolderAccountId);
        if (result === 'CANCELED') await this.#operatorCancelOne(tx, row, input.nowMs);
        await tx.insert(ticketOperatorCancellation).values({
          approvalId: input.approvalId,
          ticketId: row.id,
          orderId: row.orderId,
          fraudCaseId: input.fraudCaseId,
          result,
          cancelledAt: new Date(input.nowMs),
        });
        out.push({ ticketId: row.id, result, orderId: row.orderId });
      }
      return out;
    });
  }

  /** 그 표에 들어감(IN)·통과(PASS) 스캔이 있는가(거절·확인·나감은 입장이 아니다) */
  async #entryRecorded(tx: DbTransaction, eventId: string, ticketId: string): Promise<boolean> {
    const r = await tx.execute(sql`select 1 from scan_event where event_id = ${eventId}::uuid and ticket_id = ${ticketId}::uuid and direction = 'IN' and result = 'PASS' limit 1`);
    return r.rows.length > 0;
  }

  /** 행 잠금 안: 진행 중 양도 표시를 끄고, 키를 폐기하고, 환급 상태로 바꾼다(스캐너 변경분 TICKET_STATUS·KEY_REVOKED) */
  async #operatorCancelOne(tx: DbTransaction, row: Row, nowMs: number): Promise<void> {
    const status: TicketStatus = 'REFUNDED';
    const revokedKeyId = await this.o.deviceKeys?.revokeActiveInTx(tx, row.id, nowMs);
    await tx
      .update(ticket)
      .set({ status, transferPending: false, keyRevokedAt: new Date(nowMs), version: row.version + 1 })
      .where(eq(ticket.id, row.id));
    if (this.o.changes) {
      await this.o.changes.append(tx, row.eventId, 'TICKET_STATUS', { v: 1, ticketId: row.id, status, version: row.version + 1 });
      await this.o.changes.append(tx, row.eventId, 'KEY_REVOKED', { v: 1, ticketId: row.id, keyId: revokedKeyId ? Buffer.from(revokedKeyId).toString('base64url') : null });
    }
  }

  /** 회차 취소 표 끝내기(BAT-420 GAT-110 E, 빈 뼈대) */
  async eventCancel(_input: EventCancelInput): Promise<readonly EventCancelOutcome[]> {
    throw new Error('아직 없음');
  }

  /** 입장 기록 대조(BAT-420 GAT-090 A, 빈 뼈대). scanner 스키마의 scan_event를 읽는다 */
  async entryRecords(_ticketIds: readonly string[]): Promise<readonly EntryRecord[]> {
    throw new Error('아직 없음');
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
