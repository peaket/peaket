// 운영 명령의 응답 모양(openapi Command·CommandState). 목록·상세·SSE(live)가 같은 함수를 쓴다.
import type { Principal } from '@peaket/platform';
import { z } from 'zod';
import { COMMAND_STATES, COMMAND_TYPES, type Command } from '../domain/command.js';

export const CommandIdParams = z.object({ commandId: z.uuid() }).strict();
export const CommandBody = z
  .object({
    type: z.enum(COMMAND_TYPES),
    reason: z.string().min(1).max(2000),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const RejectBody = z.object({ reason: z.string().min(1).max(2000) }).strict();
export const OpsActorView = z.object({ adminAccountId: z.string(), displayName: z.string().nullable(), role: z.string() });
export const CommandView = z.object({
  commandId: z.string(),
  type: z.enum(COMMAND_TYPES),
  state: z.enum(COMMAND_STATES),
  reason: z.string(),
  params: z.record(z.string(), z.unknown()),
  requestedBy: OpsActorView,
  eventId: z.string().nullable().optional(),
  approvalExpiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvals: z.array(z.string()),
  attempts: z.number(),
  lastError: z.string().nullable().optional(),
  executedAt: z.string().nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  canApprove: z.boolean(),
});
export const CommandBaseView = CommandView.omit({ params: true });
export const CommandPageView = z.object({ items: z.array(CommandBaseView), nextCursor: z.string().nullable() });

// 표시 이름은 identity admin_account 조회가 붙기 전까지 null이다(후속). 목록에는 params를 싣지 않는다(openapi).
export const baseViewOf = (c: Command, me?: Principal): z.output<typeof CommandBaseView> => ({
  commandId: c.commandId,
  type: c.type,
  state: c.state,
  reason: c.reason,
  requestedBy: { adminAccountId: c.requestedBy, displayName: null, role: c.requestedRole },
  ...(c.eventId !== undefined ? { eventId: c.eventId } : {}),
  ...(c.approvalExpiresAtMs !== undefined ? { approvalExpiresAt: new Date(c.approvalExpiresAtMs).toISOString() } : {}),
  createdAt: new Date(c.createdAtMs).toISOString(),
  updatedAt: new Date(c.updatedAtMs).toISOString(),
  approvals: [...c.approvals],
  attempts: c.attempts,
  ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
  ...(c.executedAtMs !== undefined ? { executedAt: new Date(c.executedAtMs).toISOString() } : {}),
  ...(c.result !== undefined ? { result: c.result } : {}),
  canApprove: c.state === 'PENDING_APPROVAL' && me !== undefined && c.requestedBy !== me.accountId,
});
export const viewOf = (c: Command, me?: Principal): z.output<typeof CommandView> => ({ ...baseViewOf(c, me), params: c.params });
