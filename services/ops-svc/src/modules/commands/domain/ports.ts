// 운영 명령 포트(저장소·실행·dry-run 원천·신호). 도메인은 DB·HTTP를 모른다.
// 상태를 바꾸는 쓰기는 모두 CommandWriter(잠근 명령 행 하나의 트랜잭션) 위에서 command-writes.ts의 함수가 한다.
import type { Command, CommandExecutionActor, CommandExecutionResult, CommandIdempotency, CommandState, CommandType, NewCommand } from './command.js';

export interface CommandListQuery {
  readonly eventId?: string;
  readonly type?: CommandType;
  readonly states?: readonly CommandState[];
  readonly cursor?: string;
  /** 이 시각 뒤에 바뀐 명령만(관제 콘솔 폴링 갱신, BAT-465) */
  readonly updatedAfterMs?: number;
  readonly limit: number;
}

export interface CommandPage {
  readonly items: readonly Command[];
  readonly nextCursor?: string;
}

/** 승인·거부 결과. EXPIRED는 기한이 지나 같은 트랜잭션에서 명령을 닫았다는 뜻이다(409) */
export type CommandDecision =
  | { readonly status: 'APPLIED'; readonly command: Command; /** 되돌리기 요청(명령 3·11)을 승인해 되돌림을 보내야 한다 */ readonly revert?: { readonly actorRef: string; readonly actorRole: string } }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'NOT_PENDING' }
  | { readonly status: 'EXPIRED'; readonly command: Command }
  | { readonly status: 'SAME_ACTOR' }
  | { readonly status: 'ROLE_FORBIDDEN' }
  /** 같은 사람이 같은 회차에 두 번(command_actor 유일 제약) */
  | { readonly status: 'DUPLICATE' };

/** 대응 표(command_actor)의 쪽(ADR-0340 결정 8). ACTOR는 연장·재시도·되돌림 실행처럼 유일 제약이 없는 행위다 */
export type ActorSide = 'REQUESTER' | 'APPROVER' | 'ACTOR';

/** 같은 (명령, 회차, 관리 계정)의 REQUESTER·APPROVER 두 번째 행(command_actor 부분 유일 색인) */
export class DuplicateCommandActor extends Error {
  constructor() {
    super('같은 회차에 같은 사람의 요청·승인 행이 이미 있다');
    this.name = 'DuplicateCommandActor';
  }
}

/** 명령 사건 한 줄(command_event). 사람 칸은 가명 참조다 */
export interface NewCommandEvent {
  readonly type: string;
  readonly actorRef: string;
  readonly actorRole: string;
  readonly reason: string;
  /** DRY_RUN 사건의 dry-run 기록(승인자가 보는 값) */
  readonly dryRun?: Record<string, unknown>;
  /** 사건마다 다른 값(연장의 새 만료, 실행 뒤 비교 등) */
  readonly detail?: Record<string, unknown>;
  readonly ackedAtMs?: number;
  readonly nowMs: number;
}

/** 명령 상태 표(ops_command)의 바꿀 칸. null은 비운다 */
export interface CommandPatch {
  readonly state?: CommandState;
  readonly approvalExpiresAtMs?: number | null;
  readonly expiresAtMs?: number | null;
  readonly compareDueAtMs?: number | null;
  readonly attempts?: number;
  readonly lastError?: string | null;
  readonly executedAtMs?: number | null;
  readonly result?: Record<string, unknown> | null;
  readonly round?: number;
  readonly nowMs: number;
}

/** 승인·거부 한 줄(command_approval) */
export interface NewCommandApproval {
  readonly approverRef: string;
  readonly approverRole: string;
  readonly requesterRef: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly reason?: string;
  readonly round: number;
  readonly nowMs: number;
}

/** 잠근 명령 행 하나의 쓰기(한 트랜잭션). 던지면 모두 되돌아간다(명령 행·사건·대응·감사, ASVS 2.3.3) */
export interface CommandWriter {
  /** 지금까지 쓴 것을 반영한 명령 */
  readonly current: Command;
  /**
   * 대응 행을 넣고 새 가명 참조(UUIDv4)를 준다. ref를 주면 그 값을 가명 참조로 쓴다(부르는 쪽이 미리 만든 참조, 실행 체크포인트와 같은 값).
   * @throws DuplicateCommandActor 같은 회차의 REQUESTER·APPROVER에 같은 관리 계정이 이미 있음
   */
  actor(side: ActorSide, round: number, accountId: string, nowMs: number, ref?: string): Promise<string>;
  /** 그 회차의 요청자(가명 참조와, 대응이 남아 있으면 관리 계정 ID) */
  requesterOf(round: number): Promise<{ readonly ref: string; readonly accountId?: string } | undefined>;
  /** 그 회차에 이미 승인·거부가 있는가 */
  decidedIn(round: number): Promise<boolean>;
  event(e: NewCommandEvent): Promise<void>;
  patch(p: CommandPatch): Promise<void>;
  approval(a: NewCommandApproval): Promise<void>;
  /** 감사 체인에 한 기록을 같은 트랜잭션으로 덧붙인다 */
  audit(recordType: string, payload: Record<string, unknown>, nowMs: number): Promise<void>;
}

/** 정비 작업이 고르는 때가 된 명령 */
export type CommandDueKind = 'APPROVAL_EXPIRED' | 'REVERT_EXPIRED' | 'AUTO_EXPIRE';

export interface CommandStore {
  /** 명령과 첫 사건(들), 대응 행, 감사 기록, 멱등 기록을 한 트랜잭션에 쓴다 */
  create(input: NewCommand): Promise<Command>;
  /** create와 같고, 같은 멱등 키로 겹쳐 온 요청이라 처음 명령을 돌려줬으면 replayed가 참이다(새 일 없음) */
  insert(input: NewCommand): Promise<{ readonly command: Command; readonly replayed: boolean }>;
  /**
   * 같은 멱등 키의 처음 명령 ID(보관 기간 안, 커밋된 것만). 없으면 undefined.
   * 같은 키에 다른 지문이면 422 idempotency-key-reused를 던진다
   */
  replayOf(idem: CommandIdempotency, nowMs: number): Promise<string | undefined>;
  find(commandId: string): Promise<Command | undefined>;
  list(query: CommandListQuery): Promise<CommandPage>;
  /** 명령 행을 잠그고(FOR UPDATE) 쓴다. 없으면 undefined */
  mutate<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined>;
  /** 정비: 때가 된 명령 하나를 FOR UPDATE SKIP LOCKED로 골라 쓴다. 고른 것이 없으면 false */
  mutateDue(kind: CommandDueKind, nowMs: number, fn: (w: CommandWriter) => Promise<void>): Promise<boolean>;
  /** 실행 뒤 비교 때가 된 명령 ID(잠그지 않는다. 쓸 때 mutate가 다시 본다) */
  dueForCompare(nowMs: number, limit: number): Promise<readonly string[]>;
  /** 적은 시각이 before보다 이른 대응 행을 지운다(삭제 보류 행은 남긴다). 지운 행 수 */
  purgeActors(beforeMs: number): Promise<number>;
  /** PENDING_APPROVAL·REVERT_PENDING을 승인한다(approverRef는 승인자 관리 계정 ID) */
  approve(commandId: string, approverRef: string, approverRole: string, nowMs: number): Promise<CommandDecision>;
  /** PENDING_APPROVAL·REVERT_PENDING을 거부한다 */
  reject(commandId: string, approverRef: string, approverRole: string, reason: string, nowMs: number): Promise<CommandDecision>;
  /** 실행을 시작한 명령을 DISPATCHED로 바꾸고 시도 횟수를 올리며 사건·감사를 남긴다. actor는 재시도한 사람(없으면 SYSTEM) */
  markDispatched(commandId: string, nowMs: number, actor?: { readonly accountId: string; readonly role: string; readonly ref?: string }): Promise<Command>;
  /** 대상 실행이 성공한 명령을 유형의 성공 상태(ACKED·SUCCEEDED)로 바꾸고 결과·사건·감사를 남긴다 */
  markSucceeded(commandId: string, result: Record<string, unknown> | undefined, nowMs: number, ackedAtMs?: number): Promise<Command>;
  /** 대상 실행이 실패한 명령을 FAILED로 바꾸고 사유·사건·감사를 남긴다 */
  markDispatchFailed(commandId: string, reason: string, nowMs: number): Promise<Command>;
}

/** 판매 재개 막기(BAT-420 GAT-110, ADR-0280 결정 2): 그 회차에 CANCEL 요청이 APPROVED·RUNNING·PAUSED·COMPLETED인가 */
export interface CancelledEventGuard {
  isCancelled(eventId: string): Promise<boolean>;
}

/** 되돌림·연장을 보낸 결과(ADR-0340 결정 5). 실패면 명령은 ACKED·원래 만료 그대로다 */
export type CommandSendResult = { readonly status: 'ACKED'; readonly ackedAtMs?: number } | { readonly status: 'FAILED'; readonly error: string };

/** 승인된 명령을 실제 대상에 실행하는 포트. 카탈로그 명령의 전송은 OPS-300·310이 잇는다 */
export interface CommandExecutor {
  execute(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult>;
  /** 되돌림(직전 값 복원·재개·해제)을 보낸다. 없으면 보내지 못한 것으로 본다(target-not-wired) */
  revert?(command: Command, actor: CommandExecutionActor): Promise<CommandSendResult>;
  /** 명령 2의 바뀐 만료 시각을 보낸다. 없으면 보내지 못한 것으로 본다(target-not-wired) */
  extend?(command: Command, expiresAtMs: number, actor: CommandExecutionActor): Promise<CommandSendResult>;
}

/** 운영 명령 지표(ops_command_dry_run_unavailable_total{type,key}) */
export interface CommandSignals {
  dryRunUnavailable(type: CommandType, key: string): void;
}
export const noCommandSignals: CommandSignals = { dryRunUnavailable: () => undefined };

/**
 * 보안 사건 로그(정규 로그 한 줄). 사람 이름·관리 계정 ID는 싣지 않는다.
 * ops_block_protected_range(ADR-0339 결정 5), ops_command_authz_denied(실패한 권한 시도, ASVS 16.3.2)
 */
export interface CommandSecurityEvents {
  blockProtectedRange(e: { readonly commandId: string; readonly requesterRole: string; readonly hits: readonly { readonly category: string; readonly label: string }[] }): void;
  authzDenied(e: { readonly commandId?: string; readonly role: string; readonly reason: string; readonly action: string }): void;
}
export const noCommandSecurityEvents: CommandSecurityEvents = { blockProtectedRange: () => undefined, authzDenied: () => undefined };
