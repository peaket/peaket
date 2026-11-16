// 부정 예매 운영자 취소의 purchase DB 저장소(0022 fraud_cancellation_request·fraud_cancellation_ticket, docs/data.md, BUILD_ORDER GAT-080).
// 요청 기록은 승인 ID 기본 키의 INSERT 경합으로 한 번만 만들고(겹친 호출은 EXISTS와 먼저 쓴 기록), 표별 결과는 (승인, 표)로 쓰되 행이 없거나 FAILED일 때만 바꾼다.
// 환급 진행은 받은 표의 order_cancellation 상태를 읽는다(REFUNDED → REFUNDED·status_changed_at, refund_failed_at 있음·VOIDED → NEEDS_CS, 그 밖 PENDING).
import type { Database } from '@peaket/platform';
import { asc, eq, sql } from 'drizzle-orm';
import { FRAUD_FAILURE_CODES, FRAUD_TICKET_OUTCOMES, type FraudFailureCode, type FraudRefundProgress, type FraudTicketOutcome, type FraudTicketResult } from '../../domain/fraud-cancellation.js';
import type { FraudCancellationRequestRecord, FraudCancellationStore } from '../../domain/ports.js';
import { fraudCancellationRequest, fraudCancellationTicket } from './schema.js';

const OUTCOMES: ReadonlySet<string> = new Set(FRAUD_TICKET_OUTCOMES);
const FAILURES: ReadonlySet<string> = new Set(FRAUD_FAILURE_CODES);

type RequestRow = typeof fraudCancellationRequest.$inferSelect;
type TicketRow = typeof fraudCancellationTicket.$inferSelect;

const requestOf = (r: RequestRow): FraudCancellationRequestRecord => ({
  approvalId: r.approvalId,
  fraudCaseId: r.fraudCaseId,
  eventId: r.eventId,
  fingerprint: r.targetsHash,
  requestedBy: r.requestedBy,
  approvedBy: r.approvedBy,
  ...(r.approvedAt ? { approvedAtMs: r.approvedAt.getTime() } : {}),
  createdAtMs: r.createdAt.getTime(),
});

const resultOf = (r: TicketRow): FraudTicketResult => {
  if (!OUTCOMES.has(r.outcome)) throw new Error(`알 수 없는 운영자 취소 결과: ${r.outcome}`);
  if (r.failureCode !== null && !FAILURES.has(r.failureCode)) throw new Error(`알 수 없는 실패 까닭: ${r.failureCode}`);
  return {
    ticketId: r.ticketId,
    outcome: r.outcome as FraudTicketOutcome,
    ...(r.cancellationId !== null ? { cancellationId: r.cancellationId } : {}),
    ...(r.refundAmount !== null ? { refundAmount: r.refundAmount } : {}),
    ...(r.withdrawnTransferOfferId !== null ? { withdrawnTransferOfferId: r.withdrawnTransferOfferId } : {}),
    ...(r.failureCode !== null ? { failureCode: r.failureCode as FraudFailureCode } : {}),
  };
};

type RefundRow = { ticket_id: string; cancellation_id: string; status: string | null; refund_failed_at: Date | string | null; status_changed_at: Date | string | null };

const refundOf = (row: RefundRow): FraudRefundProgress => {
  if (row.status === 'REFUNDED') {
    return { ticketId: row.ticket_id, cancellationId: row.cancellation_id, state: 'REFUNDED', ...(row.status_changed_at !== null ? { refundedAtMs: new Date(row.status_changed_at).getTime() } : {}) };
  }
  const needsCs = row.status === 'VOIDED' || row.refund_failed_at !== null;
  return { ticketId: row.ticket_id, cancellationId: row.cancellation_id, state: needsCs ? 'NEEDS_CS' : 'PENDING' };
};

export class DrizzleFraudCancellationStore implements FraudCancellationStore {
  constructor(readonly database: Database) {}

  async find(approvalId: string): Promise<FraudCancellationRequestRecord | undefined> {
    const [row] = await this.database.db.select().from(fraudCancellationRequest).where(eq(fraudCancellationRequest.approvalId, approvalId)).limit(1);
    return row ? requestOf(row) : undefined;
  }

  async create(r: FraudCancellationRequestRecord): Promise<{ readonly status: 'CREATED' } | { readonly status: 'EXISTS'; readonly record: FraudCancellationRequestRecord }> {
    const inserted = await this.database.db
      .insert(fraudCancellationRequest)
      .values({
        approvalId: r.approvalId,
        fraudCaseId: r.fraudCaseId,
        eventId: r.eventId,
        targetsHash: r.fingerprint,
        requestedBy: r.requestedBy,
        approvedBy: r.approvedBy,
        approvedAt: r.approvedAtMs === undefined ? null : new Date(r.approvedAtMs),
        createdAt: new Date(r.createdAtMs),
      })
      .onConflictDoNothing({ target: fraudCancellationRequest.approvalId })
      .returning({ approvalId: fraudCancellationRequest.approvalId });
    if (inserted.length > 0) return { status: 'CREATED' };
    // 겹친 호출이 먼저 썼다(INSERT 경합에서 진 쪽은 커밋된 기록을 읽는다)
    const existing = await this.find(r.approvalId);
    if (!existing) throw new Error('운영자 취소 요청 기록을 만들지도 읽지도 못했다');
    return { status: 'EXISTS', record: existing };
  }

  async results(approvalId: string): Promise<readonly FraudTicketResult[]> {
    const rows = await this.database.db.select().from(fraudCancellationTicket).where(eq(fraudCancellationTicket.approvalId, approvalId)).orderBy(asc(fraudCancellationTicket.ticketId));
    return rows.map(resultOf);
  }

  /** (승인, 표)마다 쓴다. 이미 있는 행은 FAILED일 때만 바꾼다(늦게 온 실패가 끝난 결과를 덮지 못한다) */
  async saveResults(approvalId: string, results: readonly (FraudTicketResult & { readonly expectedHolderAccountId: string })[], nowMs: number): Promise<void> {
    if (results.length === 0) return;
    const now = new Date(nowMs);
    await this.database.db
      .insert(fraudCancellationTicket)
      .values(
        results.map((r) => ({
          approvalId,
          ticketId: r.ticketId,
          expectedHolderAccountId: r.expectedHolderAccountId,
          outcome: r.outcome,
          cancellationId: r.cancellationId ?? null,
          refundAmount: r.refundAmount ?? null,
          withdrawnTransferOfferId: r.withdrawnTransferOfferId ?? null,
          failureCode: r.failureCode ?? null,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [fraudCancellationTicket.approvalId, fraudCancellationTicket.ticketId],
        set: {
          outcome: sql`excluded.outcome`,
          cancellationId: sql`excluded.cancellation_id`,
          refundAmount: sql`excluded.refund_amount`,
          withdrawnTransferOfferId: sql`excluded.withdrawn_transfer_offer_id`,
          failureCode: sql`excluded.failure_code`,
          updatedAt: sql`excluded.updated_at`,
        },
        // 끝난 결과(ACCEPTED·SKIPPED_*)는 덮어 쓰지 않는다. FAILED 행만 바꾼다(리뷰 B5, docs/features/transfer-refund.md §7.4 '결과 저장')
        setWhere: sql`${fraudCancellationTicket.outcome} = 'FAILED'`,
      });
  }

  async refunds(approvalId: string): Promise<readonly FraudRefundProgress[]> {
    const r = await this.database.db.execute(sql`
      select t.ticket_id::text as ticket_id, t.cancellation_id::text as cancellation_id, c.status, c.refund_failed_at, c.status_changed_at
      from fraud_cancellation_ticket t
      left join order_cancellation c on c.id = t.cancellation_id
      where t.approval_id = ${approvalId}::uuid and t.outcome = 'ACCEPTED'
      order by t.ticket_id`);
    return (r.rows as RefundRow[]).map(refundOf);
  }
}
