// 운영 명령의 값·상태·2인 승인 규칙(GAT-110 첫 몫, docs/features/control-tower.md §3·§4, openapi Command·CommandState).
// 이 골격은 접수·상태·2인 승인까지다. 제어 gRPC 전달·ack·되돌리기·사후 검토는 후속이다.

export const COMMAND_TYPES = [
  'ADMISSION_TARGET',
  'ADMISSION_PAUSE',
  'KILL_SWITCH',
  'BLOCK_ASN_IP',
  'BOT_LEVEL',
  'DEGRADED_MODE',
  'LOBBY_BANNER',
  'LOG_LEVEL',
  'FEATURE_OFF',
  'TAKEDOWN',
  'AUTOMATION_STOP',
  'PG_ASSIGN',
  'EVENT_CANCEL',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_STATES = [
  'DRAFTED',
  'DRY_RUN',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'DISPATCHED',
  'ACKED',
  'FAILED',
  'REVERT_PENDING',
  'REVERTED',
  'AUTO_EXPIRED',
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/** 승인 방식. NONE은 commander 1인 즉시 실행(명령 3·11), ONE은 1인 승인, TWO는 요청자 아닌 두 번째 승인 */
export type ApprovalMode = 'NONE' | 'ONE' | 'TWO';

/**
 * 명령 유형별 승인 방식(docs/features/control-tower.md §3의 승인 요건).
 * BLOCK_ASN_IP는 ASN·넓은 대역·보호 대역이면 2인이지만, 이 골격은 안전하게 늘 2인으로 둔다.
 */
export function approvalModeOf(type: CommandType): ApprovalMode {
  if (type === 'KILL_SWITCH' || type === 'AUTOMATION_STOP') return 'NONE';
  if (type === 'BOT_LEVEL' || type === 'DEGRADED_MODE' || type === 'BLOCK_ASN_IP' || type === 'EVENT_CANCEL') return 'TWO';
  return 'ONE';
}

export function stateAfterCreate(mode: ApprovalMode): CommandState {
  return mode === 'TWO' ? 'PENDING_APPROVAL' : 'APPROVED';
}

/** 두 번째 승인 기한 10분 [가정](control-tower §4 T7) */
export const APPROVAL_TTL_MS = 10 * 60_000;

export interface Command {
  readonly commandId: string;
  readonly type: CommandType;
  readonly state: CommandState;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  readonly requestedBy: string;
  readonly requestedRole: string;
  readonly eventId?: string;
  readonly approvalExpiresAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly approvals: readonly string[];
}

/** 만들기 결과. TWO면 PENDING_APPROVAL, 그 밖은 APPROVED다 */
export interface NewCommand {
  readonly commandId: string;
  readonly type: CommandType;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  readonly requestedBy: string;
  readonly requestedRole: string;
  readonly eventId?: string;
  readonly nowMs: number;
}
