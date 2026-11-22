// 운영 명령의 값·상태·전이·2인 승인 규칙(docs/features/control-tower.md §3·§4, openapi Command·CommandState, ADR-0339·0340).
// 상태 쓰기는 모두 전이 함수 nextCommandState(전이 표 T1~T17)를 지난다. 안전 한계는 이 파일 한 곳(SAFETY_LIMITS)의 정적 값이다.
import { blockApprovalOf, blockListsOf, type BlockApproval } from './block-ranges.js';
import { DEFAULT_PROTECTED_RANGES, type ProtectedRangeList } from './protected-ranges.js';

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
  'EVENT_REFUND_PAUSE',
  'EVENT_REFUND_RESUME',
  'SCALE_CHANGE',
  'SALE_STOP',
  'SALE_RESUME',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** 카탈로그 명령 1~12(control-tower §3). 받는 쪽 ack로 ACKED가 성공이고 되돌릴 수 있다(ADR-0340 결정 1) */
export const CATALOG_COMMAND_TYPES: readonly CommandType[] = [
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
];
/** 1회 실행 명령. SUCCEEDED가 끝이고 되돌리지 않는다(ADR-0340 결정 1) */
export const ONE_SHOT_COMMAND_TYPES: readonly CommandType[] = ['EVENT_CANCEL', 'EVENT_REFUND_PAUSE', 'EVENT_REFUND_RESUME', 'SCALE_CHANGE', 'SALE_STOP', 'SALE_RESUME'];

export const isCatalogCommand = (type: CommandType): boolean => CATALOG_COMMAND_TYPES.includes(type);
/** 성공한 끝 상태: 카탈로그 명령은 ACKED, 1회 실행 명령은 SUCCEEDED */
export const successStateOf = (type: CommandType): 'ACKED' | 'SUCCEEDED' => (isCatalogCommand(type) ? 'ACKED' : 'SUCCEEDED');
/** 되돌리기에 두 번째 승인이 드는 명령 3·11(T14·T15, ADR-0073) */
export const REVERT_NEEDS_APPROVAL: readonly CommandType[] = ['KILL_SWITCH', 'AUTOMATION_STOP'];
/**
 * 되돌리기 요청에 재인증(X-Reauth-Token)이 드는 명령: 명령 3·11의 되돌리기 요청(T14)과 명령 6 Degraded Mode 모두 해제
 * (commander 1인이 사유를 적고 재인증해 실행, control-tower §3 명령 6·ADR-0105, BAT-355 리뷰 RV-03)
 */
export const REVERT_NEEDS_REAUTH: readonly CommandType[] = ['KILL_SWITCH', 'DEGRADED_MODE', 'AUTOMATION_STOP'];

/**
 * 명령 6의 해제 갈래 모드 이름(F-02-2 OPS-310, ADR-0366 결정 8): 결제사 장애로 payment-svc가 스스로 건 새 결제 진입 정지를 commander 1인이 재인증 뒤 바로 연다.
 * 승인 대기가 없고(NONE) 되돌리지 않는다(409 command-not-revertible)
 */
export const PAYMENT_ENTRY_RELEASE = 'PAYMENT_ENTRY_RELEASE';
/** 명령 6이 해제 갈래(mode PAYMENT_ENTRY_RELEASE)인가 */
export const isEntryReleaseParams = (type: CommandType, params: unknown): boolean =>
  type === 'DEGRADED_MODE' && typeof params === 'object' && params !== null && !Array.isArray(params) && (params as Record<string, unknown>).mode === PAYMENT_ENTRY_RELEASE;
/** 되돌릴 수 있는 명령인가: 카탈로그 명령이고 명령 6 해제 갈래가 아니다(ADR-0366 결정 8) */
export const isRevertibleCommand = (c: { readonly type: CommandType; readonly params?: unknown }): boolean => isCatalogCommand(c.type) && !isEntryReleaseParams(c.type, c.params);

export const COMMAND_STATES = [
  'DRAFTED',
  'DRY_RUN',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'DISPATCHED',
  'ACKED',
  'SUCCEEDED',
  'FAILED',
  'REVERT_PENDING',
  'REVERTED',
  'AUTO_EXPIRED',
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/**
 * 안전 한계(ADR-0340 결정 9, control-tower §3·§4). 정적 설정이라 운영 명령으로 바꾸지 못한다.
 * 명령 1 목표의 그 회차 결제사 상한은 원천이 생긴 뒤 더한다(BAT-355 계획 '감독에게' 1)
 */
export const SAFETY_LIMITS = Object.freeze({
  /** 명령 1 목표 절대 상한(명) */
  admissionTargetMax: 8_000,
  /** 명령 1 목표 절대 하한(명) */
  admissionTargetMin: 1_000,
  /** 명령 2 입장 일시정지 최대 시간(첫 ack·연장부터) */
  admissionPauseMs: 10 * 60_000,
  /** 명령 4 차단 만료 최대(지금부터) */
  blockMaxTtlMs: 24 * 60 * 60_000,
  /** 명령 4 대역·ASN 항목 합계 상한 [가정] */
  blockMaxEntries: 100,
  /** 명령 8 로그 레벨 자동 복귀(첫 ack부터) */
  logLevelMs: 30 * 60_000,
  /** 두 번째 승인·되돌리기 승인 기한 */
  approvalTtlMs: 10 * 60_000,
});

/** 두 번째 승인 기한 10분(control-tower §4 T7·T16) */
export const APPROVAL_TTL_MS = SAFETY_LIMITS.approvalTtlMs;
/** 실행 뒤 비교 때: 처음 DISPATCHED + 5분 [가정](ADR-0340 결정 3) */
export const DRY_RUN_COMPARE_DELAY_MS = 5 * 60_000;
/** 정비 작업 간격 30초 [가정](승인 기한·자동 만료·실행 뒤 비교, ADR-0340 결정 3·4·5) */
export const COMMAND_MAINTENANCE_INTERVAL_MS = 30_000;
/** 관리 계정 대응 행 보관 3년 [가정](ADR-0149 결정 3). 하루 한 번 지운다 */
export const ACTOR_MAPPING_RETENTION_MS = 3 * 365 * 24 * 60 * 60_000;
export const ACTOR_MAPPING_PURGE_INTERVAL_MS = 24 * 60 * 60_000;
/** 시스템 행위자의 가명 참조(모든 자리가 0인 UUID, 대응 행 없음, ADR-0340 결정 8) */
export const SYSTEM_ACTOR_REF = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_ROLE = 'system';

/** 만료가 있는 명령 2·8의 첫 ack 뒤 만료 시간(T17). 명령 4는 OPS-290 몫이다 */
export function expiryAfterAckMs(type: CommandType): number | undefined {
  if (type === 'ADMISSION_PAUSE') return SAFETY_LIMITS.admissionPauseMs;
  if (type === 'LOG_LEVEL') return SAFETY_LIMITS.logLevelMs;
  return undefined;
}
/** 정비 작업이 AUTO_EXPIRED로 적는 유형(명령 2·8). 명령 4는 waf-block-expirer 확인 뒤 markAutoExpired로 적는다(OPS-290) */
export const AUTO_EXPIRE_TYPES: readonly CommandType[] = ['ADMISSION_PAUSE', 'LOG_LEVEL'];

/** 승인 방식. NONE은 commander 1인 즉시 실행(명령 3·11), ONE은 1인 승인, TWO는 요청자 아닌 두 번째 승인 */
export type ApprovalMode = 'NONE' | 'ONE' | 'TWO';

/** 명령 유형별 요청·승인·재시도 역할. operator는 commander 전용 명령을 요청·승인·재시도할 수 없다 */
export interface CommandRolePolicy {
  readonly requesterRoles: readonly string[];
  readonly approverRoles: readonly string[];
}

const ALL_ROLES = ['operator', 'commander'] as const;
const COMMANDER_ONLY = ['commander'] as const;

/**
 * 명령 유형별 역할(B3-H01, docs/features/control-tower.md §3·§4, POL-021·POL-038).
 * 킬스위치·자동화 정지·봇 강도는 commander만 요청·승인·재시도한다. 판매 중지·재개는 operator 이상이 요청하고
 * 요청자가 아닌 commander가 승인한다(POL-038 ⑩, ADR-0123 결정 2).
 * Degraded Mode(명령 6)는 commander가 요청하고 요청자 아닌 operator 이상이 승인한다(control-tower §3 6행, ADR-0349 결정 6.
 * 명령 5의 같은 어긋남은 BAT-365). 회차 취소(EVENT_CANCEL)는 2인 승인을 유지하되 문서처럼 operator 이상이 승인한다.
 */
const COMMAND_ROLE_POLICY: Readonly<Record<CommandType, CommandRolePolicy>> = {
  ADMISSION_TARGET: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  ADMISSION_PAUSE: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  KILL_SWITCH: { requesterRoles: COMMANDER_ONLY, approverRoles: COMMANDER_ONLY },
  BLOCK_ASN_IP: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  BOT_LEVEL: { requesterRoles: COMMANDER_ONLY, approverRoles: COMMANDER_ONLY },
  DEGRADED_MODE: { requesterRoles: COMMANDER_ONLY, approverRoles: ALL_ROLES },
  LOBBY_BANNER: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  LOG_LEVEL: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  FEATURE_OFF: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  TAKEDOWN: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  AUTOMATION_STOP: { requesterRoles: COMMANDER_ONLY, approverRoles: COMMANDER_ONLY },
  PG_ASSIGN: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  EVENT_CANCEL: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  EVENT_REFUND_PAUSE: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  EVENT_REFUND_RESUME: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  SCALE_CHANGE: { requesterRoles: ALL_ROLES, approverRoles: ALL_ROLES },
  SALE_STOP: { requesterRoles: ALL_ROLES, approverRoles: COMMANDER_ONLY },
  SALE_RESUME: { requesterRoles: ALL_ROLES, approverRoles: COMMANDER_ONLY },
};

/** 되돌리기 요청(명령 3·11)의 승인 역할: 요청자 아닌 operator 이상 1인(T15) */
export const REVERT_APPROVER_ROLES: readonly string[] = ALL_ROLES;

export function rolePolicyOf(type: CommandType): CommandRolePolicy {
  return COMMAND_ROLE_POLICY[type];
}

export function requesterRolesOf(type: CommandType): readonly string[] {
  return COMMAND_ROLE_POLICY[type].requesterRoles;
}

export function approverRolesOf(type: CommandType): readonly string[] {
  return COMMAND_ROLE_POLICY[type].approverRoles;
}

/** 명령 4의 2인 판정(ADR-0339 결정 1). 목록을 읽지 못하면 안전하게 2인이다(접수 검사가 따로 422로 막는다) */
export function blockApprovalOfParams(params: Record<string, unknown> | undefined, list: ProtectedRangeList = DEFAULT_PROTECTED_RANGES): BlockApproval {
  if (!params) return { mode: 'TWO', reasons: ['UNPARSED'], hits: [] };
  try {
    return blockApprovalOf(blockListsOf(params), list);
  } catch {
    return { mode: 'TWO', reasons: ['UNPARSED'], hits: [] };
  }
}

/**
 * 명령 유형별 승인 방식(docs/features/control-tower.md §3의 승인 요건). 명령 4는 params로 판정한다(ADR-0339 결정 1):
 * ASN·넓은 대역·보호 대역이면 2인, 그 밖은 1인. params가 없거나 읽지 못하면 2인이다.
 */
export function approvalModeOf(type: CommandType, params?: Record<string, unknown>, list: ProtectedRangeList = DEFAULT_PROTECTED_RANGES): ApprovalMode {
  if (type === 'KILL_SWITCH' || type === 'AUTOMATION_STOP') return 'NONE';
  // 명령 6 해제 갈래는 commander 1인 즉시 실행이다(ADR-0366 결정 8)
  if (isEntryReleaseParams(type, params)) return 'NONE';
  // 판매 중지·재개는 판 팬·파트너 매출·정산을 바로 묶으므로 요청자가 아닌 두 번째 사람이 승인한다(ADR-0123 결정 2).
  if (type === 'SALE_STOP' || type === 'SALE_RESUME') return 'TWO';
  if (type === 'BLOCK_ASN_IP') return blockApprovalOfParams(params, list).mode;
  if (type === 'BOT_LEVEL' || type === 'DEGRADED_MODE' || type === 'EVENT_CANCEL') return 'TWO';
  return 'ONE';
}

/** 위험 명령: 2인 승인 명령과 멈추는 쪽 명령 3·11(명령 4는 2인 조건일 때만, control-tower §3 '위험 명령 재인증의 첫 구현') */
export function reauthRequiredFor(type: CommandType, params?: Record<string, unknown>, list: ProtectedRangeList = DEFAULT_PROTECTED_RANGES): boolean {
  return approvalModeOf(type, params, list) === 'TWO' || type === 'KILL_SWITCH' || type === 'AUTOMATION_STOP' || isEntryReleaseParams(type, params);
}

export function stateAfterCreate(mode: ApprovalMode): CommandState {
  return mode === 'TWO' ? 'PENDING_APPROVAL' : 'APPROVED';
}

/** 전이 표(control-tower §4 T1~T17). T9S는 1회 실행 명령의 성공(ADR-0340 결정 1) */
export interface CommandTransition {
  readonly id: string;
  readonly from: CommandState | undefined;
  readonly to: CommandState;
  /** 이 전이를 쓰는 유형(없으면 모두) */
  readonly only?: (type: CommandType) => boolean;
}

const oneStepRevert = (type: CommandType) => isCatalogCommand(type) && !REVERT_NEEDS_APPROVAL.includes(type);
const twoStepRevert = (type: CommandType) => REVERT_NEEDS_APPROVAL.includes(type);

export const COMMAND_TRANSITIONS: readonly CommandTransition[] = Object.freeze([
  { id: 'T1', from: undefined, to: 'DRAFTED' },
  { id: 'T2', from: 'DRAFTED', to: 'DRY_RUN' },
  { id: 'T4', from: 'DRY_RUN', to: 'PENDING_APPROVAL' },
  { id: 'T5', from: 'DRY_RUN', to: 'APPROVED' },
  { id: 'T6', from: 'PENDING_APPROVAL', to: 'APPROVED' },
  { id: 'T7', from: 'PENDING_APPROVAL', to: 'REJECTED' },
  { id: 'T8', from: 'APPROVED', to: 'DISPATCHED' },
  { id: 'T9', from: 'DISPATCHED', to: 'ACKED', only: isCatalogCommand },
  { id: 'T9S', from: 'DISPATCHED', to: 'SUCCEEDED', only: (t: CommandType) => !isCatalogCommand(t) },
  { id: 'T10', from: 'DISPATCHED', to: 'FAILED' },
  { id: 'T11', from: 'FAILED', to: 'DISPATCHED' },
  // 시스템 자동 조치는 명령 1의 목표 낮추기뿐이다(ADR-0340 결정 6)
  { id: 'T12', from: undefined, to: 'DISPATCHED', only: (t: CommandType) => t === 'ADMISSION_TARGET' },
  { id: 'T13', from: 'ACKED', to: 'REVERTED', only: oneStepRevert },
  { id: 'T14', from: 'ACKED', to: 'REVERT_PENDING', only: twoStepRevert },
  { id: 'T15', from: 'REVERT_PENDING', to: 'REVERTED', only: twoStepRevert },
  { id: 'T16', from: 'REVERT_PENDING', to: 'ACKED', only: twoStepRevert },
  { id: 'T17', from: 'ACKED', to: 'AUTO_EXPIRED', only: (t: CommandType) => AUTO_EXPIRE_TYPES.includes(t) || t === 'BLOCK_ASN_IP' },
] satisfies CommandTransition[]);

/** 전이 표에 없는 상태 쓰기 */
export class IllegalCommandTransition extends Error {
  constructor(
    readonly from: CommandState | undefined,
    readonly to: CommandState,
    readonly type: CommandType,
  ) {
    super(`전이 표에 없는 상태 쓰기다: ${from ?? '(시작)'} → ${to} (${type})`);
    this.name = 'IllegalCommandTransition';
  }
}

/** 전이 번호. 표에 없으면 undefined */
export function transitionOf(from: CommandState | undefined, to: CommandState, type: CommandType): CommandTransition | undefined {
  return COMMAND_TRANSITIONS.find((t) => t.from === from && t.to === to && (!t.only || t.only(type)));
}

/**
 * 모든 상태 쓰기가 지나는 전이 함수. 표에 있으면 도착 상태를 돌려주고, 없으면 던진다.
 * @throws IllegalCommandTransition
 */
export function nextCommandState(from: CommandState | undefined, to: CommandState, type: CommandType): CommandState {
  if (!transitionOf(from, to, type)) throw new IllegalCommandTransition(from, to, type);
  return to;
}

export interface Command {
  readonly commandId: string;
  readonly type: CommandType;
  readonly state: CommandState;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  /** 요청한 관리 계정 ID(대응 표로 푼 값). 대응이 지워졌거나 시스템이면 빈 글자 */
  readonly requestedBy: string;
  /** 요청자의 가명 참조(ops_command.requested_by). 저장소가 늘 채운다(저장소 밖에서 만든 값은 없을 수 있다) */
  readonly requesterRef?: string;
  readonly requestedRole: string;
  readonly eventId?: string;
  /** 승인 기한(PENDING_APPROVAL·REVERT_PENDING일 때만) */
  readonly approvalExpiresAtMs?: number;
  /** 만료 시각(명령 2·8의 첫 ack 뒤, 연장하면 바뀜) */
  readonly expiresAtMs?: number;
  /** 실행 뒤 비교 때(예측이 있는 명령의 처음 DISPATCHED + 5분) */
  readonly compareDueAtMs?: number;
  /** 0은 명령, 되돌리기 요청마다 1씩 오른다(없으면 0) */
  readonly round?: number;
  /** 지금 회차의 되돌리기 요청자 관리 계정 ID(REVERT_PENDING일 때) */
  readonly revertRequestedBy?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** 회차 0(명령)의 승인·거부한 관리 계정 ID(대응 표로 푼 값, 결정 차례) */
  readonly approvals: readonly string[];
  /** 실행 시도 횟수(재시도 포함). 첫 실행 전에는 0 */
  readonly attempts: number;
  /** 마지막 실행 실패 사유. 성공하면 비운다 */
  readonly lastError?: string;
  /** 마지막 실행이 끝난 시각(성공·실패 모두) */
  readonly executedAtMs?: number;
  /** 대상이 돌려준 결과(성공했을 때만) */
  readonly result?: Record<string, unknown>;
  /** 접수 때 기록한 dry-run(DRY_RUN 사건의 dry_run, 상세에서만 읽는다) */
  readonly dryRun?: Record<string, unknown>;
  /** 첫 ack 시각(상세에서만 읽는다) */
  readonly ackedAtMs?: number;
  /** 명령 3·11 사후 검토 보고서 작성 기한(command_post_review.due_at, 처음 DISPATCHED + 48시간, ADR-0349 결정 7). 할 일이 없으면 없다 */
  readonly postReviewDueAtMs?: number;
  /** 지금 보내는(마지막으로 보낸) 제어 판 번호(ops_command.control_version, 원장이 매김, ADR-0365 결정 1). 제어 gRPC로 보내지 않는 명령은 없다 */
  readonly controlVersion?: number;
  /** 그 판을 보내기 시작한 시각(ops_command.control_sent_at). ack 시한 10초의 기준이다(ADR-0073 결정 17) */
  readonly controlSentAtMs?: number;
  /** 전파 상태(openapi CommandState.delivery, 상세에서만 붙인다) */
  readonly delivery?: CommandDeliveryView;
}

/** 제어 gRPC 명령의 전파 상태(openapi CommandState.delivery의 ACK 갈래, ADR-0365 결정 4) */
export interface CommandDeliveryView {
  readonly kind: 'ACK';
  readonly ackedCount: number;
  readonly targetCount: number;
  /** ack하지 않은 받는 쪽('<서비스>/<파드 이름 또는 주소>@<범위>') */
  readonly unackedTargets: readonly string[];
}

/** 실행을 요청한 관리 계정. 대상 서비스에 넘길 신원 머리를 만드는 데 쓴다 */
export interface CommandExecutionActor {
  readonly accountId: string;
  readonly sessionId: string;
  readonly role: string;
}

/**
 * 대상 실행 결과. 실패는 명령을 FAILED로 남기고 재시도할 수 있게 한다.
 * ACKED는 받는 쪽이 판 N 이상을 적용했다는 답(ADR-0103)이다. 성공 상태는 유형이 정한다(successStateOf)
 */
export type CommandExecutionResult =
  | { readonly status: 'SUCCEEDED'; readonly detail?: Record<string, unknown> }
  | { readonly status: 'ACKED'; readonly ackedAtMs?: number; readonly detail?: Record<string, unknown> }
  | { readonly status: 'FAILED'; readonly error: string };

/** 만들기 입력. 저장소는 승인 방식으로 첫 상태를 정한다(TWO면 PENDING_APPROVAL, 그 밖은 APPROVED) */
export interface NewCommand {
  readonly commandId: string;
  readonly type: CommandType;
  readonly reason: string;
  readonly params: Record<string, unknown>;
  /** 요청한 관리 계정 ID. 저장소가 가명 참조로 바꿔 쓰고 대응 표에만 남긴다 */
  readonly requestedBy: string;
  readonly requestedRole: string;
  readonly eventId?: string;
  readonly nowMs: number;
  /** 접수 때 계산한 dry-run(없으면 빈 기록) */
  readonly dryRun?: Record<string, unknown>;
  /** 승인 방식(없으면 approvalModeOf(type, params)) */
  readonly approvalMode?: ApprovalMode;
  /** 멱등 기록(POST /v1/ops/commands의 Idempotency-Key). 같은 트랜잭션의 첫 쓰기다 */
  readonly idempotency?: CommandIdempotency;
  /** 시스템 자동 조치(T12): 승인 없이 DISPATCHED, 행위자 SYSTEM, 대응 행 없음 */
  readonly system?: boolean;
  /** 실행 뒤 비교를 할 예측이 있는가(시스템 자동 조치는 만들 때 비교 때를 적는다) */
  readonly hasPrediction?: boolean;
}

/** 멱등 기록 범위: 부른 계정 × 작업 CREATE_OPS_COMMAND × 키(ADR-0340 결정 7) */
export interface CommandIdempotency {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}
export const CREATE_OPS_COMMAND = 'CREATE_OPS_COMMAND';
