// 승인 업무 Drizzle 스키마(ops DB approval_request·approval_vote·promoter_contract_change, BAT-615, ADR-0320).
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const amount = (name: string) => bigint(name, { mode: 'number' });

export const approvalRequest = pgTable(
  'approval_request',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    targetRef: text('target_ref').notNull(),
    /** 결제자 계정(F-06-3, 0038). 응답·감사·로그에 싣지 않는다 */
    targetAccountId: uuid('target_account_id'),
    /** 양도 회수 승인 시점의 보유자(F-06-3, 0039) */
    expectedHolderAccountId: uuid('expected_holder_account_id'),
    /** 재량 면제의 여러 주문(F-06-3, 0038) */
    relatedOrderIds: jsonb('related_order_ids').$type<string[]>(),
    fraudAction: text('fraud_action'),
    requestedRole: text('requested_role'),
    amount: amount('amount'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text').notNull().default(''),
    evidenceChecked: text('evidence_checked'),
    requestedBy: uuid('requested_by').notNull(),
    requesterRole: text('requester_role').notNull().default(''),
    requiredApprovals: integer('required_approvals').notNull().default(2),
    status: text('status').notNull().default('PENDING_APPROVAL'),
    closeReason: text('close_reason'),
    dueAt: at('due_at'),
    /** 양도 회수의 소명 기한(요청 + 1일, F-06-3) */
    appealNotBefore: at('appeal_not_before'),
    /** BOOKING_RESTRICTION의 제한 끝 시각(F-06-4) */
    restrictionEndsAt: at('restriction_ends_at'),
    /** BOOKING_RESTRICTION의 집행 사본 상태(F-06-4). queue·purchase가 모두 반영되면 false */
    restrictionCopyPending: boolean('restriction_copy_pending').notNull().default(false),
    restrictionCopyNextAt: at('restriction_copy_next_at'),
    restrictionCopyAttempts: integer('restriction_copy_attempts').notNull().default(0),
    /** 양도 회수의 입장 시작(F-06-3) */
    entryStartsAt: at('entry_starts_at'),
    /** 1영업일 상위 알림을 한 번만 열기 위한 시각(F-06-3) */
    escalatedAt: at('escalated_at'),
    approverId: uuid('approver_id'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('approval_request_status_check', sql`${t.status} in ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ESCALATED', 'EXECUTING', 'DONE', 'FAILED', 'WITHDRAWN', 'EXPIRED')`),
    check('approval_request_required_approvals_check', sql`${t.requiredApprovals} between 1 and 3`),
    index('approval_request_status_idx').on(t.status, t.createdAt),
    index('approval_request_target_account_idx').on(t.kind, t.targetAccountId, t.createdAt),
  ],
);

export const approvalVote = pgTable(
  'approval_vote',
  {
    requestId: uuid('request_id').notNull().references(() => approvalRequest.id),
    approverId: uuid('approver_id').notNull(),
    requesterId: uuid('requester_id').notNull(),
    approvedAt: at('approved_at').notNull(),
    reason: text('reason'),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.approverId] }), check('approval_vote_not_requester_check', sql`${t.approverId} <> ${t.requesterId}`)],
);

export const promoterContractChange = pgTable('promoter_contract_change', {
  approvalId: uuid('approval_id')
    .primaryKey()
    .references(() => approvalRequest.id),
  promoterId: uuid('promoter_id').notNull(),
  currentCommissionRateBp: integer('current_commission_rate_bp').notNull(),
  currentGuaranteeRateBp: integer('current_guarantee_rate_bp').notNull(),
  currentGuaranteeKind: text('current_guarantee_kind').notNull(),
  currentValidFrom: at('current_valid_from').notNull(),
  requestedCommissionRateBp: integer('requested_commission_rate_bp'),
  requestedGuaranteeRateBp: integer('requested_guarantee_rate_bp'),
  requestedGuaranteeKind: text('requested_guarantee_kind'),
  reasonText: text('reason_text').notNull(),
  createdAt: at('created_at').notNull(),
});
