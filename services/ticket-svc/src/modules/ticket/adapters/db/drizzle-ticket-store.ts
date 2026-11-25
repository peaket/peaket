// 운영 티켓 저장소(BUILD_ORDER HOT-160). 발권은 (order_id, issue_generation) PK의 INSERT 경합으로 한 번만 만들고,
// 취소는 티켓 행 FOR UPDATE 안에서 조건을 보고 (cancellation_id, ticket_id) 취소표를 남긴다.
import type { Database, DbTransaction } from '@peaket/platform';
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { IssueStoreInput, TicketStore } from '../../domain/ports.js';
import {
  type BlockTicketIssuanceResult,
  type CancelTicketOutcome,
  type CancelTicketsInput,
  type EntryRecord,
  type EventCancelInput,
  type EventCancelOutcome,
  type HeldTicket,
  EVENT_CANCEL_ENDED_STATUSES,
  type IssueTicketsResult,
  type ListTicketsInput,
  type ListTicketsResult,
  type NormalizedBlockTicketIssuanceInput,
  type OperatorCancelInput,
  type OperatorCancelOutcome,
  type OperatorCancelResult,
  FAN_CANCEL_REASON,
  operatorCancelResultOf,
  replayOnlyResultOf,
  type ReviewEligibilityTicket,
  type TicketRecord,
  TicketConflictError,
  TicketInputError,
  TicketIssueBlockedError,
  type TicketStatus,
  walletCursorOf,
  walletTicketOf,
} from '../../domain/ticket.js';
import { ticket, ticketCancellation, ticketIssue, ticketIssueGuard, ticketOperatorCancellation, fraudTransferLock, transferOffer } from './schema.js';

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

/** ticket_cancellation.result의 회차 취소 값(팬 취소의 REFUND_NOW·REFUND_AFTER_CLOSE와 따로 센다) */
const EVENT_CANCELED = 'EVENT_CANCELED';

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
  fraudLockVersion: Number(r.fraudLockVersion),
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
  fraudLockCaseId: t.fraudLockCaseId ?? null,
  fraudLockVersion: t.fraudLockVersion ?? 0,
  version: t.version,
  eventStartsAt: t.eventStartsAtMs === undefined ? null : new Date(t.eventStartsAtMs),
  createdAt: new Date(t.issuedAtMs),
});

export class DrizzleTicketStore implements TicketStore {
  constructor(private readonly o: DrizzleTicketStoreOptions) {}

  async issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult> {
    return this.o.database.transaction(async (tx) => {
      // 발권 막기와 같은 주문 잠금(ticket_issue_guard 행). 행이 없으면 잠금 자리를 먼저 만든다(BAT-011, ADR-0355 결정 2)
      await tx.insert(ticketIssueGuard).values({ orderId: input.orderId }).onConflictDoNothing({ target: ticketIssueGuard.orderId });
      const [guard] = await tx
        .select({ blockedAt: ticketIssueGuard.blockedAt })
        .from(ticketIssueGuard)
        .where(eq(ticketIssueGuard.orderId, input.orderId))
        .limit(1)
        .for('update');
      if (guard?.blockedAt) throw new TicketIssueBlockedError();
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
      // 부정 예매 양도 잠금이 걸린 계정이 그 회차 표를 새로 사면 발권 때 잠근다(R-T31 ⑬, ADR-0171).
      // 입장 시작은 잠금 행에 없으므로 여기서는 기한만 본다(화면·양도 판정은 activeTransferLock이 입장 시작까지 본다).
      const nowMs = input.nowMs ?? Date.now();
      const [lock] = await tx
        .select({ caseId: fraudTransferLock.caseId, version: fraudTransferLock.version })
        .from(fraudTransferLock)
        .where(
          and(
            eq(fraudTransferLock.eventId, input.eventId),
            eq(fraudTransferLock.accountId, input.payerAccountId),
            eq(fraudTransferLock.locked, true),
            gt(fraudTransferLock.expiresAt, new Date(nowMs)),
          ),
        )
        .orderBy(desc(fraudTransferLock.version))
        .limit(1);
      await tx.insert(ticket).values(candidates.map((c) => ({ ...valuesOf(c), ...(lock ? { fraudLockCaseId: lock.caseId, fraudLockVersion: lock.version } : {}) })));
      if (this.o.changes) {
        for (const t of candidates) {
          await this.o.changes.append(tx, input.eventId, 'TICKET_STATUS', { v: 1, ticketId: t.ticketId, status: t.status, version: t.version });
        }
      }
      return { tickets: candidates, replayed: false };
    });
  }

  /**
   * 주문 단위 발권 막기(BAT-011 HOT-161, ticket.proto BlockTicketIssuance, ADR-0355 결정 2, docs/data.md ticket_issue_guard).
   * 한 트랜잭션에서 guard 행을 잠그고(발권과 같은 차례), 그 주문의 티켓 행을 ID 차례로 잠근 뒤 아직 VOIDED·REFUNDED가 아닌 것을 VOIDED로 바꾸고
   * 키를 폐기한다(스캐너 변경분 TICKET_STATUS). 이미 입장 기록(IN·PASS)이 있는 티켓 수를 함께 돌려준다.
   * 주문 ID로 멱등하다: 다시 부르면 새로 무효로 한 수가 0이고 alreadyEntered는 같다. 뒤에 오는 IssueTickets는 guard 행 때문에 FAILED_PRECONDITION이다
   */
  async blockIssue(input: NormalizedBlockTicketIssuanceInput): Promise<BlockTicketIssuanceResult> {
    const now = new Date(input.nowMs);
    return this.o.database.transaction(async (tx) => {
      // ① guard 행을 만들거나 잠근다(issue와 같은 잠금). 새 행은 곧바로 막힌 표시를 단다
      await tx
        .insert(ticketIssueGuard)
        .values({ orderId: input.orderId, blockedAt: now, reason: input.reason ?? null })
        .onConflictDoNothing({ target: ticketIssueGuard.orderId });
      const [guard] = await tx
        .select({ blockedAt: ticketIssueGuard.blockedAt })
        .from(ticketIssueGuard)
        .where(eq(ticketIssueGuard.orderId, input.orderId))
        .limit(1)
        .for('update');
      if (!guard) throw new Error('발권 막기 guard 행을 잠그지 못했다(코드 오류)');
      // ② 앞선 발권이 만든 잠금 자리(blocked_at 빔)면 지금 막힌 것으로 바꾼다. 이미 막혔으면 처음 사유·시각을 그대로 둔다(멱등)
      if (!guard.blockedAt) {
        await tx.update(ticketIssueGuard).set({ blockedAt: now, reason: input.reason ?? null }).where(eq(ticketIssueGuard.orderId, input.orderId));
      }
      // ③ 그 주문의 티켓을 잠그고 끝나지 않은 것만 무효로 한다(행 잠금 차례는 티켓 ID 차례라 다른 취소·무효와 교착하지 않는다)
      const rows = await tx.select().from(ticket).where(eq(ticket.orderId, input.orderId)).orderBy(asc(ticket.id)).for('update');
      let voided = 0;
      for (const row of rows) {
        const status = statusOf(row.status);
        if (status === 'VOIDED' || status === 'REFUNDED') continue;
        const revokedKeyId = await this.o.deviceKeys?.revokeActiveInTx(tx, row.id, input.nowMs);
        await tx
          .update(ticket)
          .set({ status: 'VOIDED', keyRevokedAt: now, version: row.version + 1 })
          .where(eq(ticket.id, row.id));
        if (this.o.changes) {
          await this.o.changes.append(tx, row.eventId, 'TICKET_STATUS', { v: 1, ticketId: row.id, status: 'VOIDED', version: row.version + 1 });
          if (revokedKeyId) await this.o.changes.append(tx, row.eventId, 'KEY_REVOKED', { v: 1, ticketId: row.id, keyId: Buffer.from(revokedKeyId).toString('base64url') });
        }
        voided += 1;
      }
      // ④ 입장 기록이 있는 티켓 수(다시 불러도 같다). scan_event의 색인 앞 칸(event_id)을 쓰도록 티켓과 event_id로 잇는다(RV-08)
      const entered = await tx.execute(sql`
        select count(distinct s.ticket_id)::int as n
        from ticket t
        join scan_event s on s.ticket_id = t.id and s.event_id = t.event_id
        where t.order_id = ${input.orderId}::uuid and s.direction = 'IN' and s.result = 'PASS'`);
      const alreadyEntered = Number((entered.rows[0] as { n: number | string } | undefined)?.n ?? 0);
      return { voided, alreadyEntered };
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
      .select({ cancellationId: ticketCancellation.cancellationId, result: ticketCancellation.result, reason: ticketCancellation.reason, cancelledAt: ticketCancellation.cancelledAt })
      .from(ticketCancellation)
      .where(and(eq(ticketCancellation.ticketId, ticketId), inArray(ticketCancellation.result, ['REFUND_NOW', 'REFUND_AFTER_CLOSE'])))
      .orderBy(asc(ticketCancellation.cancelledAt), asc(ticketCancellation.cancellationId))
      .limit(1);
    // 그 표를 끝낸 기록이 팬 취소(사유 USER)일 때만 잇는다. 일괄 환불 항목·사유 없는 옛 기록은 비운다(다시 보기 R1)
    if (!row || (row.result !== 'REFUND_NOW' && row.result !== 'REFUND_AFTER_CLOSE') || row.reason !== FAN_CANCEL_REASON) return undefined;
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
      // 그 취소의 사유(다시 보기 R1). 첫 팬 취소 칸은 USER 기록만 싣는다
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
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
        // 표를 끝내는 같은 트랜잭션에서 진행 중 양도 요청을 FRAUD_LOCK으로 거둔다(불변식 D1, 정본 §7.4 ①)
        const withdrawnTransferOfferId = result === 'CANCELED' ? await this.#operatorCancelOne(tx, row, input.nowMs, 'FRAUD_LOCK') : undefined;
        await tx.insert(ticketOperatorCancellation).values({
          approvalId: input.approvalId,
          ticketId: row.id,
          orderId: row.orderId,
          fraudCaseId: input.fraudCaseId,
          result,
          withdrawnTransferOfferId: withdrawnTransferOfferId ?? null,
          cancelledAt: new Date(input.nowMs),
        });
        out.push({ ticketId: row.id, result, orderId: row.orderId, ...(withdrawnTransferOfferId ? { withdrawnTransferOfferId } : {}) });
      }
      return out;
    });
  }

  /** 그 표에 들어감(IN)·통과(PASS) 스캔이 있는가(거절·확인·나감은 입장이 아니다) */
  async #entryRecorded(tx: DbTransaction, eventId: string, ticketId: string): Promise<boolean> {
    const r = await tx.execute(sql`select 1 from scan_event where event_id = ${eventId}::uuid and ticket_id = ${ticketId}::uuid and direction = 'IN' and result = 'PASS' limit 1`);
    return r.rows.length > 0;
  }

  /**
   * 행 잠금 안: 진행 중 양도 요청을 거두고(사유·결정 시각), 키를 폐기하고, 환급 상태로 바꾼다(스캐너 변경분 TICKET_STATUS·KEY_REVOKED).
   * 거둔 요청 ID를 돌려준다(운영자 취소 기록의 withdrawn_transfer_offer_id, 회차 취소의 transferWithdrawn).
   */
  async #operatorCancelOne(tx: DbTransaction, row: Row, nowMs: number, withdrawReason: 'EVENT_CANCELLED' | 'FRAUD_LOCK'): Promise<string | undefined> {
    const status: TicketStatus = 'REFUNDED';
    const withdrawn = await tx
      .update(transferOffer)
      .set({ status: 'WITHDRAWN', withdrawReason, decidedAt: new Date(nowMs) })
      .where(and(eq(transferOffer.ticketId, row.id), eq(transferOffer.status, 'OFFERED')))
      .returning({ id: transferOffer.id });
    const revokedKeyId = await this.o.deviceKeys?.revokeActiveInTx(tx, row.id, nowMs);
    await tx
      .update(ticket)
      .set({ status, transferPending: false, keyRevokedAt: new Date(nowMs), version: row.version + 1 })
      .where(eq(ticket.id, row.id));
    if (this.o.changes) {
      await this.o.changes.append(tx, row.eventId, 'TICKET_STATUS', { v: 1, ticketId: row.id, status, version: row.version + 1 });
      await this.o.changes.append(tx, row.eventId, 'KEY_REVOKED', { v: 1, ticketId: row.id, keyId: revokedKeyId ? Buffer.from(revokedKeyId).toString('base64url') : null });
    }
    return withdrawn[0]?.id;
  }

  /**
   * 회차 취소 표 끝내기(BAT-420 GAT-110 E, R-T24, docs/features/transfer-refund.md §5 '대상 선택과 보류 취소 전환').
   * 한 트랜잭션에서 대상 표의 행을 모두 잠그고(FOR UPDATE, 표 ID 차례) 요청 차례로 가른다. 없는 표·다른 회차 표가 있으면 TicketInputError로
   * 트랜잭션째 되돌린다. (cancellation_id, ticket_id) 기록이 있으면 처음 결과다(잠금 뒤에 본다). 환급·무효인 표는 아무것도 쓰지 않고,
   * 나머지는 진행 중 양도 표시를 끄고 키를 폐기해 환급 상태로 두며 ticket_cancellation(EVENT_CANCELED)을 남긴다. 결제자·보유자·입장·공연 시작은 보지 않는다.
   * 팬 취소(cancel)와 같은 행 잠금을 잡으므로 같은 표를 동시에 노려도 하나만 키를 폐기한다
   */
  async eventCancel(input: EventCancelInput): Promise<readonly EventCancelOutcome[]> {
    return this.o.database.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(ticket)
        .where(inArray(ticket.id, input.targets.map((t) => t.ticketId)))
        .orderBy(ticket.id)
        .for('update');
      const byId = new Map(locked.map((r) => [r.id, r]));
      for (const target of input.targets) {
        const row = byId.get(target.ticketId);
        if (!row || row.eventId !== input.eventId) throw new TicketInputError('없는 표이거나 다른 회차의 표다');
      }
      const out: EventCancelOutcome[] = [];
      for (const target of input.targets) {
        const row = byId.get(target.ticketId)!;
        const base = { ticketId: row.id, orderId: row.orderId, holderAccountId: row.accountId };
        const recorded = await tx
          .select({ result: ticketCancellation.result })
          .from(ticketCancellation)
          .where(and(eq(ticketCancellation.cancellationId, target.cancellationId), eq(ticketCancellation.ticketId, target.ticketId)))
          .limit(1);
        if (recorded[0]) {
          // 다시 부르기: 처음 끝낸 결과다(양도 표시는 그때 껐으므로 이번 호출은 끄지 않았다)
          out.push({ ...base, result: recorded[0].result === EVENT_CANCELED ? 'CANCELED' : 'ALREADY_ENDED', transferWithdrawn: false });
          continue;
        }
        const status = statusOf(row.status);
        if (EVENT_CANCEL_ENDED_STATUSES.has(status)) {
          out.push({ ...base, result: 'ALREADY_ENDED', transferWithdrawn: false });
          continue;
        }
        // 회차 취소도 같은 트랜잭션에서 진행 중 요청을 EVENT_CANCELLED로 거둔다(불변식 D1, 정본 §5)
        const withdrawn = await this.#operatorCancelOne(tx, row, input.nowMs, 'EVENT_CANCELLED');
        await tx.insert(ticketCancellation).values({ cancellationId: target.cancellationId, ticketId: row.id, orderId: row.orderId, result: EVENT_CANCELED, cancelledAt: new Date(input.nowMs) });
        // 옛 표시만 있고 요청 행이 없는 데이터도 '껐다'로 답한다(GAT-110 E2가 보는 지금 뜻 그대로)
        out.push({ ...base, result: 'CANCELED', transferWithdrawn: withdrawn !== undefined || row.transferPending || status === 'TRANSFER_PENDING' });
      }
      return out;
    });
  }

  /**
   * 입장 기록 대조(BAT-420 GAT-090 A, P-T19). scan_event의 들어감(IN)·통과(PASS)만 입장으로 세고, 입장 시각은 기기가 찍은 시각(scanned_at_device)의
   * 가장 이른 값이다. 거절·확인·나감은 입장이 아니다. 읽기만 하고 요청 차례로 준다
   */
  async entryRecords(ticketIds: readonly string[]): Promise<readonly EntryRecord[]> {
    const ids = sql.join(
      ticketIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const r = await this.o.database.db.execute(sql`
      select t.id as ticket_id, min(s.scanned_at_device) as first_in
      from ticket t
      left join scan_event s on s.ticket_id = t.id and s.event_id = t.event_id and s.direction = 'IN' and s.result = 'PASS'
      where t.id in (${ids})
      group by t.id`);
    const found = new Map((r.rows as { ticket_id: string; first_in: Date | string | null }[]).map((x) => [x.ticket_id, x.first_in]));
    return ticketIds.map((ticketId) => {
      if (!found.has(ticketId)) return { ticketId, found: false, entered: false };
      const firstIn = found.get(ticketId);
      if (firstIn === null || firstIn === undefined) return { ticketId, found: true, entered: false };
      return { ticketId, found: true, entered: true, firstEnteredAtMs: new Date(firstIn).getTime() };
    });
  }

  async listReviewEligibility(eventId: string): Promise<readonly ReviewEligibilityTicket[]> {
    const rows = await this.o.database.db
      .select({ accountId: ticket.accountId, payerAccountId: ticket.payerAccountId, orderId: ticket.orderId, status: ticket.status, createdAt: ticket.createdAt })
      .from(ticket)
      .where(eq(ticket.eventId, eventId));
    return rows.map((r) => ({ accountId: r.accountId, payerAccountId: r.payerAccountId, orderId: r.orderId, status: statusOf(r.status), issuedAtMs: r.createdAt.getTime() }));
  }

  /** 보유 티켓 확인(ListHeldTickets). 지금 보유자 칸 account_id로 찾는다(ticket_wallet_idx의 앞 칸), 회차·상태는 그 안에서 거른다 */
  async listHeld(accountId: string, eventId: string, statuses: readonly TicketStatus[]): Promise<readonly HeldTicket[]> {
    if (statuses.length === 0) return [];
    const rows = await this.o.database.db
      .select({ id: ticket.id, status: ticket.status })
      .from(ticket)
      .where(and(eq(ticket.accountId, accountId), eq(ticket.eventId, eventId), inArray(ticket.status, [...statuses])))
      .orderBy(asc(ticket.id));
    return rows.map((r) => ({ ticketId: r.id, status: statusOf(r.status) }));
  }

  async listFraudTickets(input: { eventId: string; payerAccountIds: readonly string[] }): Promise<readonly { ticketId: string; payerAccountId: string; holderAccountId: string; status: string; entryRecorded: boolean }[]> {
    const rows = await this.o.database.pool.query(
      `select t.id, t.payer_account_id, t.account_id, t.status,
              exists(select 1 from scan_event s where s.event_id = t.event_id and s.ticket_id = t.id and s.direction = 'IN' and s.result = 'PASS') as entry_recorded
       from ticket t where t.event_id = $1 and t.payer_account_id = any($2::uuid[]) order by t.id`,
      [input.eventId, input.payerAccountIds],
    );
    return rows.rows.map((r: any) => ({ ticketId: r.id, payerAccountId: r.payer_account_id, holderAccountId: r.account_id, status: r.status, entryRecorded: r.entry_recorded === true }));
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
    // 목록 항목의 pendingTransfer: 이 쪽의 표들에 지금 OFFERED 요청이 있으면 한 번에 읽어 붙인다
    const open =
      page.length === 0
        ? []
        : await this.o.database.db
            .select({ ticketId: transferOffer.ticketId, offerId: transferOffer.id, expiresAt: transferOffer.expiresAt })
            .from(transferOffer)
            .where(and(inArray(transferOffer.ticketId, page.map((r) => r.id)), eq(transferOffer.status, 'OFFERED')));
    const openByTicket = new Map(open.map((o) => [o.ticketId, { offerId: o.offerId, expiresAtMs: o.expiresAt.getTime() }]));
    return {
      tickets: page.map((r) => {
        const pendingOffer = openByTicket.get(r.id);
        return walletTicketOf({ ...recordOf(r), ...(pendingOffer === undefined ? {} : { pendingOffer }) });
      }),
      ...(nextCursor ? { nextCursor } : {}),
    };
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
