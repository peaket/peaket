// 운영 명령 포트(저장소·실행·dry-run 원천·신호). 도메인은 DB·HTTP를 모른다.
// 상태를 바꾸는 쓰기는 모두 CommandWriter(잠근 명령 행 하나의 트랜잭션) 위에서 command-writes.ts의 함수가 한다.
import type { Command, CommandDeliveryView, CommandExecutionActor, CommandExecutionResult, CommandIdempotency, CommandState, CommandType, NewCommand } from './command.js';
import type { PostReviewAlertKind, PostReviewRow, PostReviewWriter } from './post-review.js';

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
  /** 지금 보내는 제어 판 번호와 그 판을 보내기 시작한 시각(ADR-0365 결정 1·4) */
  readonly controlVersion?: number | null;
  readonly controlSentAtMs?: number | null;
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
  /**
   * 설정 사건 하나를 같은 트랜잭션의 Outbox 행으로 쓴다(ADR-0349 결정 5, adapters/settings-outbox.ts publishSetting). 트랜잭션의 마지막 쓰기로 부른다.
   * 없는 저장소는 설정형 명령을 낼 수 없다(실행기가 FAILED로 남긴다)
   * @throws SettingChangeRejected 계약 꼴이 아님(트랜잭션째 되돌아간다)
   */
  setting?(s: SettingChange): Promise<string>;
  /** 설정형 명령의 적용 확인 행(같은 트랜잭션). 없으면 그 저장소는 적용 확인을 쓰지 못한다 */
  applyCheck?(row: import('./apply-check.js').ApplyCheckRow): Promise<void>;
  /** 명령 3·11의 사후 검토 행(command_post_review)을 같은 트랜잭션에서 고친다(ADR-0349 결정 7). 두 저장소가 채운다 */
  readonly postReviews?: PostReviewWriter;
  /**
   * 판 번호 원장(control_version, ADR-0365 결정 1): 범위마다 그 종류의 행을 잠그고 새 판 = max(범위들의 마지막 판 + 1, 지금 밀리초)를 매겨 모두에 쓴다.
   * 같은 트랜잭션이다. 없는 저장소는 원장이 없다(명령 기록의 바뀐 시각을 판으로 쓰던 옛 길)
   */
  assignControlVersion?(q: { readonly scopes: readonly string[]; readonly kind: string; readonly nowMs: number }): Promise<number>;
}

/** 받는 파드 하나의 ack(또는 아직 답하지 않은 대상) 한 줄(command_delivery, ADR-0365 결정 4) */
export interface ControlDeliveryRow {
  readonly commandId: string;
  readonly version: number;
  readonly service: string;
  readonly scope: string;
  /** 부른 주소(host:port) */
  readonly target: string;
  readonly podName?: string;
  readonly appliedVersion?: number;
  /** 판 이상을 답한 시각(아직이면 없다) */
  readonly ackedAtMs?: number;
  readonly nowMs: number;
}

/** 파드마다의 ack 기록(ops DB command_delivery). 기록 실패는 전송을 막지 않는다(부르는 쪽이 삼킨다) */
export interface ControlDeliveries {
  /** 그 (명령, 판, 서비스, 범위, 주소)의 줄을 쓰거나 고친다. 한 번 ack한 줄은 ack를 잃지 않는다 */
  record(row: ControlDeliveryRow): Promise<void>;
  /** 그 판의 전파 상태(줄이 없으면 undefined) */
  summary(commandId: string, version: number): Promise<CommandDeliveryView | undefined>;
}

/**
 * 명령 7의 승인된 문구 템플릿 찾기(F-02-1 리뷰 반영 RV-01, ADR-0365 결정 2 바꿈). 승인 템플릿 저장소와 banner에 싣는 글은 F-03-5(OPS-410)가 정한다.
 * 그때까지 기본 구현은 늘 '없음'이라 명령 7은 만들어지지 않는다(422 invalid-command, detail templateId)
 */
export interface LobbyBannerTemplates {
  /** 그 템플릿이 승인돼 지금 쓸 수 있는가. 읽지 못하면 던진다 */
  approved(templateId: string): Promise<boolean>;
}
export const noApprovedLobbyBannerTemplates: LobbyBannerTemplates = { approved: async () => false };

/** 받는 쪽 서비스마다 부를 주소(ADR-0365 결정 3). 운영은 헤드리스 DNS를 부를 때마다 다시 풀고, local·ci는 주소 목록이다. 실패하면 던진다 */
export interface ControlTargets {
  resolve(service: string): Promise<readonly string[]>;
}

/** 주소 하나에 ApplyControl 한 번(데드라인 1초 [가정]). 실패·시간 초과는 던진다 */
export interface ControlTransport {
  apply(service: string, address: string, req: { readonly commandId: string; readonly scope: string; readonly kind: string; readonly version: number; readonly desiredStateJson: string }): Promise<{ readonly appliedVersion: number; readonly podName: string }>;
  /** 읽기 전용 사전 모의 센 값(PreviewControl, ADR-0365 결정 11·16). 없으면 그 전송은 미리보기를 못 한다 */
  preview?(
    service: string,
    address: string,
    req: { readonly scope: string; readonly kind: string; readonly keys: readonly string[] },
  ): Promise<{
    readonly counts: readonly { readonly key: string; readonly value: number; readonly source: string; readonly measuredAtMs: number }[];
    readonly unavailable: readonly { readonly key: string; readonly reason: string }[];
    readonly podName: string;
  }>;
}

/** 받는 쪽 넷에 같은 판을 퍼뜨리고 ack를 기다리는 길(application ControlDispatcher가 구현, 실행기가 판매 중지·재개에 쓴다) */
export interface ControlDeliverer {
  /**
   * 모든 받는 쪽이 판 이상을 답할 때까지 1초 [가정]마다 같은 판으로 다시 보낸다. 시한은 min(startedAtMs + 10초, untilMs)이고 그때 못 미치면 실패다
   * (ADR-0365 결정 4. untilMs는 응답 안에서 기다리는 부르는 쪽이 요청의 남은 시간으로 준다, ASVS 15.1.3). 던지지 않는다
   */
  deliver(q: {
    readonly commandId: string;
    readonly version: number;
    readonly deliveries: readonly import('./control-kinds.js').ControlDelivery[];
    readonly startedAtMs: number;
    readonly untilMs?: number;
  }): Promise<ControlDeliverResult>;
}
export type ControlDeliverResult = { readonly ok: true; readonly ackedAtMs: number; readonly acked: number } | { readonly ok: false; readonly error: string };

/** 명령 사건 한 줄과 그 행위자(대응이 남아 있으면 관리 계정 ID). 사후 검토 ★ 칸(실행 기록·재개 시각과 승인자)을 채운다 */
export interface CommandTimelineEntry {
  readonly seq: number;
  readonly type: string;
  readonly actorRef: string;
  readonly actorRole: string;
  readonly actorAccountId?: string;
  readonly reason: string;
  readonly createdAtMs: number;
}

/** 활성 commander 목록(identity ListAdminAccounts, 1인 기간 판정). 닿지 못하면 던진다(받는 층 503, 자기 검토를 받지 않는다) */
export interface ActiveCommanders {
  list(): Promise<readonly string[]>;
}

/** 활성 commander 목록을 읽지 못함 */
export class ActiveCommandersUnavailable extends Error {
  constructor(readonly why: string) {
    super(`active-commanders-unavailable:${why}`);
    this.name = 'ActiveCommandersUnavailable';
  }
}

/** 명령 4 정비가 읽는 WAF IP 집합(가족별 대역 글자). 읽지 못하면 던진다(그 명령은 다음 바퀴로) */
export interface BlockIpSetReader {
  read(family: 4 | 6): Promise<readonly string[]>;
}

/**
 * 설정 사건 일반(asyncapi control.settings SettingChanged, ADR-0349 결정 5). 메시지 키는 '<scope>:<kind>:<target>'이고,
 * 값의 판은 occurredAtMs, eventKey는 (commandId, kind, scope)로 정한다. kind는 계약 key 열거 그대로다
 */
export interface SettingChange {
  /** 계약 key 열거의 값(PG_ASSIGNMENT, LOG_LEVEL 등) */
  readonly kind: string;
  /** PLATFORM 또는 회차 ID */
  readonly scope: string;
  /** 대상(기능 플래그 이름, 로그 레벨을 바꿀 서비스 등). 없으면 비운다 */
  readonly target?: string;
  /** 종류마다 정한 값(asyncapi value 갈래) */
  readonly value: Record<string, unknown>;
  readonly expiresAtMs?: number;
  readonly commandId: string;
  /** 명령 기록의 가명 참조(관리 계정 ID를 싣지 않는다) */
  readonly actorRef: string;
  /** 판(사건 시각) */
  readonly occurredAtMs: number;
}

/** 적용 확인 행 저장소(ops DB command_apply_check, ADR-0365 결정 14) */
export interface ApplyCheckStore {
  /** 지금 볼 행(다음 볼 시각이 지난 것)을 limit개까지. 파드 여럿이 겹치지 않게 저장소가 잠근다 */
  due(nowMs: number, limit: number): Promise<readonly import('./apply-check.js').ApplyCheckRow[]>;
  save(row: import('./apply-check.js').ApplyCheckRow): Promise<void>;
  /** 그 명령의 마지막 사건 행(단계·판이 가장 큼) */
  latestOf(commandId: string): Promise<import('./apply-check.js').ApplyCheckRow | undefined>;
  /** Outbox 행이 아직 있는지, 있으면 나간 시각(sent_at) */
  outboxOf(outboxId: string): Promise<{ readonly exists: boolean; readonly sentAtMs?: number }>;
}

/** 받는 서비스의 적용 판을 Prometheus에서 읽는 포트(ADR-0365 결정 15) */
export interface SettingsApplyProbe {
  probe(q: { readonly service: string; readonly messageKey: string; readonly version: number }): Promise<import('./apply-check.js').ProbeResult>;
}

/** 명령 12·6이 묻는 결제사 이름(ops 쪽 값, payment.proto PgProvider와 대응) */
export type PgName = 'TOSS' | 'PORTONE' | 'SIMULATOR';

/** 하위 결제사 판정 결과(payment-svc CheckEventPgAssignment, ADR-0349 결정 3). 값은 하위 결제사 이름과 까닭뿐이다 */
export interface PgAssignmentVerdict {
  readonly allowed: boolean;
  /** 걸렸을 때만: 하위 결제사 이름(포트원 PgProvider 값)과 까닭 */
  readonly conflict?: { readonly subProvider: string; readonly reason: string };
  /** 지금 회차 지정(payment-svc event_pg_config). 없으면 undefined */
  readonly current?: { readonly primaryPg: PgName; readonly fallbackPg?: PgName };
  /** 결제사별 승인 상한(초당 승인 호출). 설정에 없는 결제사는 빠진다 */
  readonly approvalLimits: Readonly<Partial<Record<PgName, number>>>;
}

/** 하위 결제사 판정 포트(ops-svc → payment-svc gRPC, 데드라인 2초 [가정]). 실패·시간 초과는 던진다(503 pg-check-unavailable) */
export interface PgAssignmentCheck {
  check(q: { readonly eventId: string; readonly primaryPg: PgName; readonly fallbackPg?: PgName }): Promise<PgAssignmentVerdict>;
}

/**
 * 명령 6 대체 결제사 전환의 갈 곳 묻기(ops-svc → payment-svc gRPC ResolvePgSwitch, 데드라인 2초 [가정], ADR-0366 결정 5).
 * 회차마다 전환이 켜졌을 때 갈 결제사와 그 승인 상한, 설정에 있는 결제사의 승인 상한을 준다. 실패·시간 초과는 던진다(503 pg-check-unavailable)
 */
export interface PgSwitchResolver {
  resolve(q: { readonly eventIds: readonly string[]; readonly toPg?: PgName }): Promise<import('./pg-switch.js').PgSwitchRoutes>;
}

/** 회차 판매 시작 읽기(core-svc 내부 판매 설정, ADR-0349 결정 2). 판매 승인 전(404)이면 undefined, 그 밖의 실패는 던진다 */
export interface OnsaleStartSource {
  saleStartMs(eventId: string): Promise<number | undefined>;
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
  /** 사후 검토 행(잠그지 않는 읽기, 조회 경로). 행이 없으면 undefined */
  postReviewOf?(commandId: string): Promise<PostReviewRow | undefined>;
  /** 기한을 넘겼는데 경보를 내지 않은 사후 검토(DUE: 제출 전, CONFIRM: 제출 뒤 검토 전). 잠그지 않는다 */
  postReviewsDue?(nowMs: number, limit: number): Promise<readonly { readonly commandId: string; readonly kind: PostReviewAlertKind }[]>;
  /** 처음 DISPATCHED를 지난 명령 3·11 가운데 사후 검토 행이 없는 것(할 일 열기를 놓친 명령을 정비가 잇는다) */
  postReviewsToOpen?(limit: number): Promise<readonly string[]>;
  /** 명령의 사건 차례와 행위자(사후 검토 ★ 칸) */
  timelineOf?(commandId: string): Promise<readonly CommandTimelineEntry[]>;
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
