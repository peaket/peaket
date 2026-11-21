// 명령 상태 쓰기(control-tower §4 T1~T17, ADR-0340). 저장소 둘(PostgreSQL·메모리)이 같은 함수를 CommandWriter 위에서 부른다.
// 모든 상태 쓰기는 nextCommandState를 지나고, 사람 칸은 가명 참조(command_actor)이며, 감사 기록은 같은 트랜잭션에 덧붙인다.
import { createHash } from 'node:crypto';
import {
  APPROVAL_TTL_MS,
  DRY_RUN_COMPARE_DELAY_MS,
  REVERT_APPROVER_ROLES,
  REVERT_NEEDS_APPROVAL,
  SAFETY_LIMITS,
  SYSTEM_ACTOR_REF,
  SYSTEM_ROLE,
  approvalModeOf,
  approverRolesOf,
  expiryAfterAckMs,
  isCatalogCommand,
  nextCommandState,
  requesterRolesOf,
  successStateOf,
  type Command,
  type CommandState,
  type NewCommand,
} from './command.js';
import type { CommandDecision, CommandWriter, NewCommandEvent } from './ports.js';

const iso = (ms: number): string => new Date(ms).toISOString();

const sortValue = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortValue((v as Record<string, unknown>)[k])]));
  return v;
};
/** 키 차례에 흔들리지 않는 JSON의 SHA-256(16진). 감사 기록에 dry-run·비교 값의 지문으로 싣는다(감사 모듈의 정규화와 같은 규칙) */
export function recordDigest(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortValue(v ?? null))).digest('hex');
}

/** 예측 값이 있는 dry-run인가(있으면 처음 DISPATCHED + 5분에 비교한다) */
export function hasPrediction(dryRun: Record<string, unknown> | undefined): boolean {
  return Array.isArray(dryRun?.predicted) && dryRun.predicted.length > 0;
}

/** 빈 dry-run(원천을 넘기지 않은 직접 호출). 세지 않았으므로 센 값·예측이 없다 */
export function emptyDryRun(input: Pick<NewCommand, 'type' | 'params'>): Record<string, unknown> {
  const mode = approvalModeOf(input.type, input.params);
  return { version: 1, approvalMode: mode, reauthRequired: mode === 'TWO' || input.type === 'KILL_SWITCH' || input.type === 'AUTOMATION_STOP', counted: [], predicted: [], unavailable: [], limits: {} };
}

export interface CreationPlan {
  readonly state: CommandState;
  readonly approvalExpiresAtMs?: number;
  readonly compareDueAtMs?: number;
  readonly attempts: number;
  /** 요청자 가명 참조(시스템이면 빈 UUID) */
  readonly requesterRef: string;
  /** 대응 행(시스템 자동 조치는 없다) */
  readonly actor?: { readonly side: 'REQUESTER'; readonly round: 0; readonly accountId: string };
  readonly events: readonly Omit<NewCommandEvent, 'nowMs'>[];
  readonly audit: { readonly recordType: string; readonly payload: Record<string, unknown> };
}

/**
 * 명령 만들기의 사건 차례(T1·T2·T4/T5, 시스템 자동 조치는 T12): CREATED → DRY_RUN(dry_run) → PENDING_APPROVAL 또는 APPROVED.
 * 감사 기록은 요청자의 가명 참조로 적는다(관리 계정 ID는 대응 표에만)
 */
export function planCreation(input: NewCommand, requesterRef: string): CreationPlan {
  const dryRun = input.dryRun ?? emptyDryRun(input);
  const digest = recordDigest(dryRun);
  if (input.system) {
    const state = nextCommandState(undefined, 'DISPATCHED', input.type);
    return {
      state,
      attempts: 1,
      ...(hasPrediction(dryRun) ? { compareDueAtMs: input.nowMs + DRY_RUN_COMPARE_DELAY_MS } : {}),
      requesterRef: SYSTEM_ACTOR_REF,
      events: [{ type: 'DISPATCHED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: input.reason, dryRun }],
      audit: { recordType: 'COMMAND_AUTO_ACTION', payload: { type: input.type, state, requestedBy: SYSTEM_ACTOR_REF, requestedRole: SYSTEM_ROLE, reason: input.reason, dryRunSha256: digest } },
    };
  }
  const mode = input.approvalMode ?? approvalModeOf(input.type, input.params);
  let state = nextCommandState(undefined, 'DRAFTED', input.type);
  state = nextCommandState(state, 'DRY_RUN', input.type);
  state = nextCommandState(state, mode === 'TWO' ? 'PENDING_APPROVAL' : 'APPROVED', input.type);
  const by = { actorRef: requesterRef, actorRole: input.requestedRole, reason: input.reason };
  return {
    state,
    attempts: 0,
    ...(mode === 'TWO' ? { approvalExpiresAtMs: input.nowMs + APPROVAL_TTL_MS } : {}),
    requesterRef,
    actor: { side: 'REQUESTER', round: 0, accountId: input.requestedBy },
    events: [
      { type: 'CREATED', ...by },
      { type: 'DRY_RUN', ...by, dryRun },
      { type: state, ...by },
    ],
    audit: { recordType: 'COMMAND_CREATED', payload: { type: input.type, state, requestedBy: requesterRef, requestedRole: input.requestedRole, reason: input.reason, dryRunSha256: digest } },
  };
}

/**
 * 승인 기한이 지났으면 같은 트랜잭션에서 닫는다(ADR-0340 결정 4). 기한과 같거나 늦은 시각이면 지난 것이다.
 * PENDING_APPROVAL → REJECTED(SYSTEM, approval-expired), REVERT_PENDING → ACKED(REVERT_EXPIRED). 닫았으면 참
 */
export async function closeIfApprovalExpired(w: CommandWriter, nowMs: number): Promise<boolean> {
  const c = w.current;
  if (c.approvalExpiresAtMs === undefined || nowMs < c.approvalExpiresAtMs) return false;
  if (c.state === 'PENDING_APPROVAL') {
    const to = nextCommandState(c.state, 'REJECTED', c.type);
    await w.audit('COMMAND_REJECTED', { decision: 'REJECTED', approverRef: SYSTEM_ACTOR_REF, approverRole: SYSTEM_ROLE, reason: 'approval-expired' }, nowMs);
    await w.event({ type: 'REJECTED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: 'approval-expired', nowMs });
    await w.patch({ state: to, approvalExpiresAtMs: null, nowMs });
    return true;
  }
  if (c.state === 'REVERT_PENDING') {
    const to = nextCommandState(c.state, 'ACKED', c.type);
    await w.audit('COMMAND_REVERT_EXPIRED', { round: c.round ?? 0, reason: 'approval-expired' }, nowMs);
    await w.event({ type: 'REVERT_EXPIRED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: 'approval-expired', nowMs });
    await w.patch({ state: to, approvalExpiresAtMs: null, nowMs });
    return true;
  }
  return false;
}

/**
 * 두 번째 승인·거부(T6·T7), 되돌리기 요청의 승인·거부(T15·T16). 응용 층이 요청자 본인을 먼저 보고(403),
 * command_actor의 회차별 유일 제약이 마지막 안전망이다(같은 사람 두 번은 DuplicateCommandActor가 던져진다)
 */
export async function writeDecision(w: CommandWriter, q: { accountId: string; role: string; decision: 'APPROVED' | 'REJECTED'; reason?: string; nowMs: number }): Promise<CommandDecision> {
  const c = w.current;
  if (c.state !== 'PENDING_APPROVAL' && c.state !== 'REVERT_PENDING') return { status: 'NOT_PENDING' };
  if (await closeIfApprovalExpired(w, q.nowMs)) return { status: 'EXPIRED', command: w.current };
  const revert = c.state === 'REVERT_PENDING';
  // 기존 행이 commander 전용 유형을 operator가 요청한 경우도 승인 단계에서 닫는다(B3-H01)
  if (!revert && !requesterRolesOf(c.type).includes(c.requestedRole)) return { status: 'ROLE_FORBIDDEN' };
  if (!(revert ? REVERT_APPROVER_ROLES : approverRolesOf(c.type)).includes(q.role)) return { status: 'ROLE_FORBIDDEN' };
  const round = c.round ?? 0;
  const requester = await w.requesterOf(round);
  const requesterAccount = requester?.accountId ?? (round === 0 && c.requestedBy !== '' ? c.requestedBy : undefined);
  if (requesterAccount !== undefined && requesterAccount === q.accountId) return { status: 'SAME_ACTOR' };
  if (revert && (await w.decidedIn(round))) return { status: 'NOT_PENDING' };
  const ref = await w.actor('APPROVER', round, q.accountId, q.nowMs);
  const requesterRef = requester?.ref ?? c.requesterRef ?? '';
  await w.approval({ approverRef: ref, approverRole: q.role, requesterRef, decision: q.decision, ...(q.reason !== undefined ? { reason: q.reason } : {}), round, nowMs: q.nowMs });
  const reasonPayload = q.reason !== undefined ? { reason: q.reason } : {};
  if (!revert) {
    const to = nextCommandState(c.state, q.decision, c.type);
    await w.audit(q.decision === 'APPROVED' ? 'COMMAND_APPROVED' : 'COMMAND_REJECTED', { decision: q.decision, approverRef: ref, approverRole: q.role, ...reasonPayload }, q.nowMs);
    await w.event({ type: q.decision, actorRef: ref, actorRole: q.role, reason: q.reason ?? c.reason, nowMs: q.nowMs });
    await w.patch({ state: to, approvalExpiresAtMs: null, nowMs: q.nowMs });
    return { status: 'APPLIED', command: w.current };
  }
  if (q.decision === 'REJECTED') {
    const to = nextCommandState(c.state, 'ACKED', c.type);
    await w.audit('COMMAND_REVERT_REJECTED', { round, approverRef: ref, approverRole: q.role, ...reasonPayload }, q.nowMs);
    await w.event({ type: 'REVERT_REJECTED', actorRef: ref, actorRole: q.role, reason: q.reason ?? c.reason, nowMs: q.nowMs });
    await w.patch({ state: to, approvalExpiresAtMs: null, nowMs: q.nowMs });
    return { status: 'APPLIED', command: w.current };
  }
  // 되돌리기 승인: 보내기 전에 감사·사건을 남긴다. 상태는 보낸 결과가 정한다(REVERTED 또는 ACKED)
  await w.audit('COMMAND_REVERT_APPROVED', { round, approverRef: ref, approverRole: q.role }, q.nowMs);
  await w.event({ type: 'REVERT_APPROVED', actorRef: ref, actorRole: q.role, reason: c.reason, nowMs: q.nowMs });
  return { status: 'APPLIED', command: w.current, revert: { actorRef: ref, actorRole: q.role } };
}

/** 실행 시작(T8·T11). 감사 기록을 DISPATCHED 사건보다 먼저 쓴다. 처음 DISPATCHED이고 예측이 있으면 비교 때를 적는다 */
export async function writeDispatched(w: CommandWriter, q: { nowMs: number; actor?: { accountId: string; role: string; ref?: string } }): Promise<Command> {
  const c = w.current;
  const to = nextCommandState(c.state, 'DISPATCHED', c.type);
  const attempts = c.attempts + 1;
  let actorRef = SYSTEM_ACTOR_REF;
  let actorRole = SYSTEM_ROLE;
  if (q.actor) {
    actorRef = await w.actor('ACTOR', c.round ?? 0, q.actor.accountId, q.nowMs, q.actor.ref);
    actorRole = q.actor.role;
  }
  const firstCompare = attempts === 1 && c.compareDueAtMs === undefined && hasPrediction(c.dryRun);
  await w.audit('COMMAND_EXECUTION_STARTED', { state: 'DISPATCHED', attempt: attempts, actorRef, actorRole }, q.nowMs);
  await w.event({ type: 'DISPATCHED', actorRef, actorRole, reason: c.reason, nowMs: q.nowMs });
  await w.patch({ state: to, attempts, lastError: null, executedAtMs: null, ...(firstCompare ? { compareDueAtMs: q.nowMs + DRY_RUN_COMPARE_DELAY_MS } : {}), nowMs: q.nowMs });
  return w.current;
}

/** 실행 성공(T9 ACKED·T9S SUCCEEDED). 명령 2·8은 첫 ack에 만료 시각을 적는다(T17 준비) */
export async function writeSucceeded(w: CommandWriter, q: { result?: Record<string, unknown>; ackedAtMs?: number; nowMs: number }): Promise<Command> {
  const c = w.current;
  const success = successStateOf(c.type);
  const to = nextCommandState(c.state, success, c.type);
  const result = q.result !== undefined ? { result: q.result } : {};
  if (success === 'ACKED') {
    const ackedAtMs = q.ackedAtMs ?? q.nowMs;
    const ttl = expiryAfterAckMs(c.type);
    const expiresAtMs = ttl !== undefined && c.expiresAtMs === undefined ? ackedAtMs + ttl : undefined;
    await w.audit('COMMAND_ACKED', { state: to, ackedAt: iso(ackedAtMs), ...(expiresAtMs !== undefined ? { expiresAt: iso(expiresAtMs) } : {}), ...result }, q.nowMs);
    await w.event({ type: 'ACKED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: c.reason, ackedAtMs, nowMs: q.nowMs });
    await w.patch({ state: to, lastError: null, executedAtMs: q.nowMs, result: q.result ?? null, ...(expiresAtMs !== undefined ? { expiresAtMs } : {}), nowMs: q.nowMs });
    return w.current;
  }
  await w.audit('COMMAND_SUCCEEDED', { state: to, ...result }, q.nowMs);
  await w.event({ type: 'SUCCEEDED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: c.reason, nowMs: q.nowMs });
  await w.patch({ state: to, lastError: null, executedAtMs: q.nowMs, result: q.result ?? null, nowMs: q.nowMs });
  return w.current;
}

/** 실행 실패(T10). 같은 명령 ID로 다시 할 수 있다(T11) */
export async function writeFailed(w: CommandWriter, q: { reason: string; nowMs: number }): Promise<Command> {
  const c = w.current;
  const to = nextCommandState(c.state, 'FAILED', c.type);
  await w.audit('COMMAND_EXECUTION_FAILED', { state: to, reason: q.reason }, q.nowMs);
  await w.event({ type: 'FAILED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: q.reason, nowMs: q.nowMs });
  await w.patch({ state: to, lastError: q.reason, executedAtMs: q.nowMs, nowMs: q.nowMs });
  return w.current;
}

export type RevertStart =
  | { readonly status: 'NOT_REVERTIBLE' }
  | { readonly status: 'ROLE_FORBIDDEN' }
  /** 명령 3·11: 두 번째 승인 대기(T14) */
  | { readonly status: 'PENDING'; readonly command: Command }
  /** 1인 되돌리기: 사건·감사를 남겼고 부르는 쪽이 보낸다(T13) */
  | { readonly status: 'DISPATCH'; readonly command: Command; readonly actorRef: string; readonly actorRole: string };

/** 되돌리기 요청(ADR-0340 결정 5). ACKED인 카탈로그 명령만. 그 유형을 낼 수 있는 역할이어야 한다 */
export async function writeRevertRequest(w: CommandWriter, q: { accountId: string; role: string; reason: string; nowMs: number }): Promise<RevertStart> {
  const c = w.current;
  if (!isCatalogCommand(c.type) || c.state !== 'ACKED') return { status: 'NOT_REVERTIBLE' };
  if (!requesterRolesOf(c.type).includes(q.role)) return { status: 'ROLE_FORBIDDEN' };
  if (REVERT_NEEDS_APPROVAL.includes(c.type)) {
    const to = nextCommandState(c.state, 'REVERT_PENDING', c.type);
    const round = (c.round ?? 0) + 1;
    const ref = await w.actor('REQUESTER', round, q.accountId, q.nowMs);
    const approvalExpiresAtMs = q.nowMs + APPROVAL_TTL_MS;
    await w.audit('COMMAND_REVERT_REQUESTED', { round, requesterRef: ref, requesterRole: q.role, reason: q.reason, approvalExpiresAt: iso(approvalExpiresAtMs) }, q.nowMs);
    await w.event({ type: 'REVERT_REQUESTED', actorRef: ref, actorRole: q.role, reason: q.reason, nowMs: q.nowMs });
    await w.patch({ state: to, round, approvalExpiresAtMs, nowMs: q.nowMs });
    return { status: 'PENDING', command: w.current };
  }
  // 보내기 전에 전이가 표에 있는지 본다(T13)
  nextCommandState(c.state, 'REVERTED', c.type);
  const ref = await w.actor('ACTOR', c.round ?? 0, q.accountId, q.nowMs);
  await w.audit('COMMAND_REVERT_STARTED', { actorRef: ref, actorRole: q.role, reason: q.reason }, q.nowMs);
  await w.event({ type: 'REVERT_STARTED', actorRef: ref, actorRole: q.role, reason: q.reason, nowMs: q.nowMs });
  return { status: 'DISPATCH', command: w.current, actorRef: ref, actorRole: q.role };
}

/**
 * 되돌림을 보낸 결과. 받으면 REVERTED(T13·T15), 보내지 못하면 ACKED 그대로(되돌리기 요청이었으면 T16)이고 REVERT_FAILED를 남긴다.
 * 보내는 동안 상태가 바뀌었으면(승인 기한 정비 등) 상태를 바꾸지 않고 REVERT_FAILED(state-changed)다. 반영했으면 참
 */
export async function writeRevertResult(w: CommandWriter, q: { ok: boolean; error?: string; actorRef: string; actorRole: string; fromPending: boolean; nowMs: number }): Promise<boolean> {
  const c = w.current;
  const expected: CommandState = q.fromPending ? 'REVERT_PENDING' : 'ACKED';
  if (c.state !== expected) {
    await w.audit('COMMAND_REVERT_FAILED', { actorRef: q.actorRef, actorRole: q.actorRole, reason: 'state-changed' }, q.nowMs);
    await w.event({ type: 'REVERT_FAILED', actorRef: q.actorRef, actorRole: q.actorRole, reason: 'state-changed', nowMs: q.nowMs });
    return false;
  }
  if (q.ok) {
    const to = nextCommandState(c.state, 'REVERTED', c.type);
    await w.audit('COMMAND_REVERTED', { round: c.round ?? 0, actorRef: q.actorRef, actorRole: q.actorRole }, q.nowMs);
    await w.event({ type: 'REVERTED', actorRef: q.actorRef, actorRole: q.actorRole, reason: c.reason, nowMs: q.nowMs });
    await w.patch({ state: to, approvalExpiresAtMs: null, nowMs: q.nowMs });
    return true;
  }
  const error = q.error ?? 'revert-failed';
  await w.audit('COMMAND_REVERT_FAILED', { actorRef: q.actorRef, actorRole: q.actorRole, reason: error }, q.nowMs);
  await w.event({ type: 'REVERT_FAILED', actorRef: q.actorRef, actorRole: q.actorRole, reason: error, nowMs: q.nowMs });
  if (q.fromPending) await w.patch({ state: nextCommandState(c.state, 'ACKED', c.type), approvalExpiresAtMs: null, nowMs: q.nowMs });
  return false;
}

export type ExtendStart =
  | { readonly status: 'NOT_EXTENDABLE' }
  | { readonly status: 'ROLE_FORBIDDEN' }
  | { readonly status: 'DISPATCH'; readonly command: Command; readonly expiresAtMs: number; readonly actorRef: string; readonly actorRole: string };

/** 연장 요청(명령 2만, ACKED이고 만료 전, ADR-0340 결정 5). 새 만료 = 지금 + 10분. EXTENDED를 남기고 부르는 쪽이 보낸다 */
export async function writeExtendStart(w: CommandWriter, q: { accountId: string; role: string; reason: string; nowMs: number }): Promise<ExtendStart> {
  const c = w.current;
  if (c.type !== 'ADMISSION_PAUSE' || c.state !== 'ACKED' || c.expiresAtMs === undefined || q.nowMs >= c.expiresAtMs) return { status: 'NOT_EXTENDABLE' };
  if (!requesterRolesOf(c.type).includes(q.role)) return { status: 'ROLE_FORBIDDEN' };
  const expiresAtMs = q.nowMs + SAFETY_LIMITS.admissionPauseMs;
  const ref = await w.actor('ACTOR', c.round ?? 0, q.accountId, q.nowMs);
  await w.audit('COMMAND_EXTENDED', { actorRef: ref, actorRole: q.role, reason: q.reason, expiresAt: iso(expiresAtMs), previousExpiresAt: iso(c.expiresAtMs) }, q.nowMs);
  await w.event({ type: 'EXTENDED', actorRef: ref, actorRole: q.role, reason: q.reason, detail: { expiresAt: iso(expiresAtMs) }, nowMs: q.nowMs });
  return { status: 'DISPATCH', command: w.current, expiresAtMs, actorRef: ref, actorRole: q.role };
}

/** 연장을 보낸 결과. 받으면 만료를 바꾸고, 보내지 못했거나 그사이 끝났으면 원래 만료 그대로 EXTEND_FAILED다. 반영했으면 참 */
export async function writeExtendResult(w: CommandWriter, q: { ok: boolean; error?: string; expiresAtMs: number; ackedAtMs?: number; actorRef: string; actorRole: string; nowMs: number }): Promise<boolean> {
  const c = w.current;
  if (q.ok && c.state === 'ACKED') {
    await w.audit('COMMAND_EXTEND_ACKED', { actorRef: q.actorRef, expiresAt: iso(q.expiresAtMs) }, q.nowMs);
    await w.event({ type: 'EXTEND_ACKED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: c.reason, ackedAtMs: q.ackedAtMs ?? q.nowMs, detail: { expiresAt: iso(q.expiresAtMs) }, nowMs: q.nowMs });
    await w.patch({ expiresAtMs: q.expiresAtMs, nowMs: q.nowMs });
    return true;
  }
  const error = q.ok ? 'state-changed' : (q.error ?? 'extend-failed');
  await w.audit('COMMAND_EXTEND_FAILED', { actorRef: q.actorRef, actorRole: q.actorRole, reason: error }, q.nowMs);
  await w.event({ type: 'EXTEND_FAILED', actorRef: q.actorRef, actorRole: q.actorRole, reason: error, nowMs: q.nowMs });
  return false;
}

/** 자동 만료(T17, 행위자 SYSTEM). ACKED가 아니면 하지 않는다. 명령 4는 waf-block-expirer 확인 뒤 부른다(OPS-290). 적었으면 참 */
export async function writeAutoExpired(w: CommandWriter, q: { reason: string; nowMs: number }): Promise<boolean> {
  const c = w.current;
  if (c.state !== 'ACKED') return false;
  const to = nextCommandState(c.state, 'AUTO_EXPIRED', c.type);
  await w.audit('COMMAND_AUTO_EXPIRED', { reason: q.reason, ...(c.expiresAtMs !== undefined ? { expiresAt: iso(c.expiresAtMs) } : {}) }, q.nowMs);
  await w.event({ type: 'AUTO_EXPIRED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: q.reason, nowMs: q.nowMs });
  await w.patch({ state: to, nowMs: q.nowMs });
  return true;
}

/** 실행 뒤 비교(ADR-0340 결정 3). 때가 됐을 때만 DRY_RUN_COMPARED(예측·실제·센 시각·차이)를 남기고 비교 때를 비운다. 적었으면 참 */
export async function writeComparison(w: CommandWriter, q: { comparison: Record<string, unknown>; nowMs: number }): Promise<boolean> {
  const c = w.current;
  if (c.compareDueAtMs === undefined || q.nowMs < c.compareDueAtMs) return false;
  await w.audit('COMMAND_DRY_RUN_COMPARED', { comparisonSha256: recordDigest(q.comparison) }, q.nowMs);
  await w.event({ type: 'DRY_RUN_COMPARED', actorRef: SYSTEM_ACTOR_REF, actorRole: SYSTEM_ROLE, reason: 'dry-run-compare', detail: q.comparison, nowMs: q.nowMs });
  await w.patch({ compareDueAtMs: null, nowMs: q.nowMs });
  return true;
}
