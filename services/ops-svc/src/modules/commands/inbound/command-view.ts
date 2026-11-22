// 운영 명령의 응답 모양(openapi Command·CommandState·CommandDryRun). 목록·상세·SSE(live)가 같은 함수를 쓴다.
// requestedBy·approvals·canApprove는 대응 표(command_actor)로 푼 관리 계정으로 만든다. 대응이 지워졌으면 역할만 보인다(ADR-0149 결정 4).
import type { Principal } from '@peaket/platform';
import { z } from 'zod';
import { COMMAND_STATES, COMMAND_TYPES, REVERT_APPROVER_ROLES, approverRolesOf, type Command } from '../domain/command.js';

export const CommandIdParams = z.object({ commandId: z.uuid() }).strict();
export const CommandBody = z
  .object({
    type: z.enum(COMMAND_TYPES),
    reason: z.string().min(1).max(2000),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const RejectBody = z.object({ reason: z.string().min(1).max(2000) }).strict();
/** 되돌리기·연장의 본문(사유 필수) */
export const ReasonBody = z.object({ reason: z.string().min(1).max(2000) }).strict();
export const OpsActorView = z.object({ adminAccountId: z.string().optional(), displayName: z.string().nullable(), role: z.string() });

const DryRunCountView = z.object({ key: z.string(), value: z.number(), source: z.string(), measuredAt: z.string() });
const DryRunPredictionView = z.object({ key: z.string(), value: z.number(), formula: z.string(), inputs: z.record(z.string(), z.number()), assumptions: z.array(z.string()) });
const DryRunUnavailableView = z.object({ key: z.string(), source: z.string(), reason: z.string() });
const ProtectedRangeHitView = z.object({ kind: z.enum(['ASN', 'CIDR']), value: z.string(), category: z.string(), label: z.string() });
export const CommandDryRunView = z.object({
  version: z.number(),
  approvalMode: z.enum(['NONE', 'ONE', 'TWO']),
  reauthRequired: z.boolean(),
  counted: z.array(DryRunCountView),
  predicted: z.array(DryRunPredictionView),
  unavailable: z.array(DryRunUnavailableView),
  limits: z.record(z.string(), z.number()),
  protectedRangeHits: z.array(ProtectedRangeHitView).optional(),
  protectedRangesVersion: z.string().optional(),
});

export const CommandView = z.object({
  commandId: z.string(),
  type: z.enum(COMMAND_TYPES),
  state: z.enum(COMMAND_STATES),
  reason: z.string(),
  params: z.record(z.string(), z.unknown()),
  requestedBy: OpsActorView,
  eventId: z.string().nullable().optional(),
  approvalExpiresAt: z.string().nullable().optional(),
  expiresAt: z.string().optional(),
  ackedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvals: z.array(z.string()),
  attempts: z.number(),
  lastError: z.string().nullable().optional(),
  executedAt: z.string().nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  dryRun: CommandDryRunView.optional(),
  canApprove: z.boolean(),
  /** 명령 3·11 사후 검토 보고서 작성 기한(ADR-0349 결정 7, openapi CommandState.postReviewDueAt) */
  postReviewDueAt: z.string().nullable().optional(),
  /** 전파 상태(openapi CommandState.delivery, 상세에만, F-02-1 ADR-0365 결정 4) */
  delivery: z
    .object({ kind: z.enum(['ACK', 'APPLY_CHECK']), ackedCount: z.number(), targetCount: z.number(), unackedTargets: z.array(z.string()), applyStatus: z.string().nullable().optional() })
    .nullable()
    .optional(),
});
export const CommandBaseView = CommandView.omit({ params: true, dryRun: true, delivery: true });
export const CommandPageView = z.object({ items: z.array(CommandBaseView), nextCursor: z.string().nullable() });

/** 부른 계정이 지금 승인·거부할 수 있는가(요청자·이미 결정한 사람 제외, 서버 판정) */
export function canApproveOf(c: Command, me?: Principal): boolean {
  if (!me || me.role === undefined) return false;
  if (c.state === 'PENDING_APPROVAL') return c.requestedBy !== me.accountId && !c.approvals.includes(me.accountId) && approverRolesOf(c.type).includes(me.role);
  if (c.state === 'REVERT_PENDING') return c.revertRequestedBy !== undefined && c.revertRequestedBy !== me.accountId && REVERT_APPROVER_ROLES.includes(me.role);
  return false;
}

// 표시 이름은 identity admin_account 조회가 붙기 전까지 null이다(후속). 목록에는 params·dryRun을 싣지 않는다(openapi).
export const baseViewOf = (c: Command, me?: Principal): z.output<typeof CommandBaseView> => ({
  commandId: c.commandId,
  type: c.type,
  state: c.state,
  reason: c.reason,
  requestedBy: { ...(c.requestedBy !== '' ? { adminAccountId: c.requestedBy } : {}), displayName: null, role: c.requestedRole },
  ...(c.eventId !== undefined ? { eventId: c.eventId } : {}),
  ...(c.approvalExpiresAtMs !== undefined ? { approvalExpiresAt: new Date(c.approvalExpiresAtMs).toISOString() } : {}),
  ...(c.expiresAtMs !== undefined ? { expiresAt: new Date(c.expiresAtMs).toISOString() } : {}),
  ...(c.ackedAtMs !== undefined ? { ackedAt: new Date(c.ackedAtMs).toISOString() } : {}),
  createdAt: new Date(c.createdAtMs).toISOString(),
  updatedAt: new Date(c.updatedAtMs).toISOString(),
  approvals: [...c.approvals],
  attempts: c.attempts,
  ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
  ...(c.executedAtMs !== undefined ? { executedAt: new Date(c.executedAtMs).toISOString() } : {}),
  ...(c.result !== undefined ? { result: c.result } : {}),
  canApprove: canApproveOf(c, me),
  ...(c.postReviewDueAtMs !== undefined ? { postReviewDueAt: new Date(c.postReviewDueAtMs).toISOString() } : {}),
});
export const viewOf = (c: Command, me?: Principal): z.output<typeof CommandView> => ({
  ...baseViewOf(c, me),
  params: c.params,
  ...(c.dryRun !== undefined ? { dryRun: c.dryRun as z.output<typeof CommandDryRunView> } : {}),
  ...(c.delivery !== undefined ? { delivery: { kind: c.delivery.kind, ackedCount: c.delivery.ackedCount, targetCount: c.delivery.targetCount, unackedTargets: [...c.delivery.unackedTargets] } } : {}),
});
