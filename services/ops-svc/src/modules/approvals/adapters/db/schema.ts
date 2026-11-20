// 승인 업무 Drizzle 스키마(ops DB approval_request·approval_vote·promoter_contract_change, BAT-615, ADR-0320).
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const amount = (name: string) => bigint(name, { mode: 'number' });

export const approvalRequest = pgTable(
  'approval_request',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    targetRef: text('target_ref').notNull(),
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
    approverId: uuid('approver_id'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => [check('approval_request_status_check', sql`${t.status} in ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ESCALATED', 'EXECUTING', 'DONE', 'FAILED', 'WITHDRAWN', 'EXPIRED')`), index('approval_request_status_idx').on(t.status, t.createdAt)],
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
