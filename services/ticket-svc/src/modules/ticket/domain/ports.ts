// 티켓 저장소 포트(BUILD_ORDER HOT-160). 메모리 구현은 단위 시험, Drizzle 구현은 운영 DB가 쓴다.
import type { DeviceKeyReason } from './device-key.js';
import type { BoothAuthorizeOutcome, BoothRequestOutcome, GateStatusView, OverridePassView } from './booth.js';
import type {
  BlockTicketIssuanceResult,
  CancelTicketOutcome,
  CancelTicketsInput,
  EntryRecord,
  EventCancelInput,
  EventCancelOutcome,
  HeldTicket,
  IssueTicketsInput,
  IssueTicketsResult,
  ListTicketsInput,
  ListTicketsResult,
  NormalizedBlockTicketIssuanceInput,
  OperatorCancelInput,
  OperatorCancelOutcome,
  ReviewEligibilityTicket,
  TicketRecord,
  TicketStatus,
} from './ticket.js';

/** 발권 저장 입력: 앱이 만든 멱등 지문을 함께 넘긴다. */
export interface IssueStoreInput extends IssueTicketsInput {
  readonly fingerprint: string;
  /** 발권 시각(잠금 판정에 쓴다). 없으면 저장소가 지금 시각을 쓴다 */
  readonly nowMs?: number;
}

export interface TicketStore {
  /**
   * 주문·세대 단위로 한 번만 발권한다. 같은 주문·세대의 재요청이면 처음 티켓을 그대로 돌려주고 replayed=true다.
   * 같은 주문·세대에 다른 내용(지문)이면 TicketConflictError다.
   * @param candidates 새로 만들 때 저장할 티켓(키 원문 포함)
   */
  issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult>;

  /**
   * 주문 단위 발권 막기(BlockTicketIssuance, BAT-011). 한 트랜잭션에서 guard 행을 잠그고, 그 주문의 티켓을 행 잠금으로 훑어
   * 아직 VOIDED·REFUNDED가 아닌 것을 VOIDED로 바꾸고 키를 폐기한다(스캐너 변경분 TICKET_STATUS). 주문 ID로 멱등하다.
   * 같은 주문의 issue도 먼저 guard 행을 잠그므로 둘은 한 차례로 갈린다
   */
  blockIssue(input: NormalizedBlockTicketIssuanceInput): Promise<BlockTicketIssuanceResult>;

  /** 티켓마다 행 잠금 안에서 조건을 보고 취소한다. cancellation_id·ticket_id 단위로 멱등하다. */
  cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]>;

  /**
   * 부정 예매 운영자 취소(BAT-415 몫 F). 한 트랜잭션, 표마다 FOR UPDATE. 없는 표·다른 회차 표는 TicketInputError(트랜잭션째 되돌림).
   * (approval_id, ticket_id) 기록이 있으면 그 결과를 그대로 준다. 결과는 요청 차례다
   */
  operatorCancel(input: OperatorCancelInput): Promise<readonly OperatorCancelOutcome[]>;

  /**
   * 회차 취소 표 끝내기(BAT-420 GAT-110 E). 한 트랜잭션, 표마다 FOR UPDATE, 요청 차례. 없는 표·다른 회차 표는 TicketInputError(트랜잭션째 되돌림).
   * (cancellation_id, ticket_id) 기록이 있으면 그 결과를 준다
   */
  eventCancel(input: EventCancelInput): Promise<readonly EventCancelOutcome[]>;

  /** 입장 기록 대조(BAT-420 GAT-090 A). 읽기만, 요청 차례 */
  entryRecords(ticketIds: readonly string[]): Promise<readonly EntryRecord[]>;

  /** 계정의 월렛 목록. 발권 최신순, 커서 페이지. */
  list(input: ListTicketsInput): Promise<ListTicketsResult>;

  /** 후기 자격 판정에 쓰는 그 회차의 티켓(모든 계정·상태). 결제자·유효 상태는 도메인이 가른다(BAT-585) */
  listReviewEligibility(eventId: string): Promise<readonly ReviewEligibilityTicket[]>;

  /**
   * 그 계정이 지금 보유자(ticket.account_id, 양도 뒤 바뀜)인 그 회차 티켓 가운데 statuses 상태만(ListHeldTickets, ADR-0301 결정 1). 읽기만, 티켓 ID 차례
   */
  listHeld(accountId: string, eventId: string, statuses: readonly TicketStatus[]): Promise<readonly HeldTicket[]>;
}

export interface DeviceKeyRegistrationInput {
  readonly ticketId: string;
  readonly accountId: string;
  readonly keyId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly reason: DeviceKeyReason;
  readonly nowMs: number;
  /** BOOTH만: 부스 요청 ID(그 허용에 묶인다) */
  readonly boothRequestId?: string;
  /** 재인증을 확인했는가. 입장 시작 뒤 첫 ISSUE, 다른 키가 유효한 ISSUE, REISSUE의 허용 근거다 */
  readonly reauthVerified: boolean;
  /** 입장 키 알림 행 ID(성공한 교체·입장 시작 뒤 첫 등록이면 이 ID로 device_key_notice 한 행, ADR-0363 결정 4). 없으면 저장소가 만든다 */
  readonly noticeId?: string;
}

/** 입장 키 알림 종류(docs/features/notify.md §4.7) */
export type DeviceKeyNoticeType = 'DEVICE_KEY_REISSUED' | 'DEVICE_KEY_LATE_ISSUE';

/**
 * 성공한 등록이 알림 행을 남기는가(ADR-0363 결정 4, docs/data.md device_key_notice). 두 저장소가 같은 규칙을 쓴다.
 * REISSUE와 키가 있던 티켓의 ISSUE(교체)는 DEVICE_KEY_REISSUED, 입장 시작 뒤 첫 ISSUE(유효 키 없음)는 DEVICE_KEY_LATE_ISSUE, 그 밖(첫 등록·TRANSFER)은 없음
 */
export function deviceKeyNoticeTypeOf(i: { reason: DeviceKeyReason; hadActive: boolean; started: boolean }): DeviceKeyNoticeType | undefined {
  if (i.reason === 'REISSUE' || (i.reason === 'ISSUE' && i.hadActive)) return 'DEVICE_KEY_REISSUED';
  if (i.reason === 'ISSUE' && i.started) return 'DEVICE_KEY_LATE_ISSUE';
  return undefined;
}

export type DeviceKeyRegistrationResult =
  /**
   * unchanged: 같은 티켓의 지금 유효 키와 keyId가 같은 요청이라 아무것도 바꾸지 않았다(새 행·폐기·scanner_change·24시간 셈 없음,
   * offline-gate §2 '같은 키 다시 등록', ADR-0336 결정 4). 응답은 처음 등록과 같은 201 `{keyId}`다
   */
  | { readonly kind: 'REGISTERED'; readonly keyId: string; readonly revokedKeyId?: string; readonly unchanged?: true; readonly noticeId?: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_HOLDER' }
  /** 재인증 필요(403 reauth-required). 지금 두 저장소는 쓰지 않는다(아래 ENTRY_STARTED가 같은 이름으로 나간다) */
  | { readonly kind: 'REAUTH_REQUIRED' }
  /** 입장 시작 뒤 첫 등록(유효 키 없음)인데 재인증이 없거나 틀림, 입장 시작 뒤 유효 키 없는 REISSUE·TRANSFER(403 reauth-required, ADR-0363 결정 2) */
  | { readonly kind: 'ENTRY_STARTED' }
  /** 입장 시작 전, 다른 키가 유효하거나 REISSUE인데 재인증이 없거나 틀림(403 reissue-required). 보유자가 아니어도 재인증 없는 REISSUE는 이것이다(404보다 403) */
  | { readonly kind: 'REISSUE_REQUIRED' }
  /** 입장 시작 뒤 다른 키가 유효함(재인증과 상관없이, ISSUE·REISSUE, 403 reissue-at-booth). 키는 바뀌지 않는다 */
  | { readonly kind: 'REISSUE_AT_BOOTH' }
  | { readonly kind: 'REISSUE_LIMIT' }
  /** 보유자가 결제자 그대로인데 TRANSFER를 부른 경우(양도 수락 전) */
  | { readonly kind: 'TRANSFER_NOT_ALLOWED' }
  /** BOOTH인데 그 boothRequestId의 허용이 없거나 지났거나 이미 썼다(403 booth-not-authorized) */
  | { readonly kind: 'BOOTH_NOT_ALLOWED' };

/** 보내기 반복이 집은 알림 행(연락처·키 값 없음) */
export interface DeviceKeyNotice {
  readonly id: string;
  readonly type: DeviceKeyNoticeType;
  readonly accountId: string;
  readonly ticketId: string;
  readonly registeredAtMs: number;
  readonly attempts: number;
}

/** 입장 키 알림 보낼 표(device_key_notice, ADR-0363 결정 4). 행은 등록 트랜잭션이 적고 보내기 반복이 이 포트로 읽는다 */
export interface DeviceKeyNoticeStore {
  /**
   * 보낼 때가 된 보내지 않은 행을 최대 limit개 잡는다(FOR UPDATE SKIP LOCKED로 고르고 next_attempt_at을 leaseMs 뒤로 밀어 다른 파드가 겹쳐 집지 않게 한다).
   * 잡은 행의 attempts는 이번 보내기를 더한 값이다
   */
  claimDue(nowMs: number, limit: number, leaseMs: number): Promise<readonly DeviceKeyNotice[]>;
  /** core-svc가 2xx·422로 답했다 */
  markSent(id: string, nowMs: number): Promise<void>;
  /** 다음 보낼 때를 정한다(1분·5분·30분 [가정]) */
  reschedule(id: string, nextAttemptAtMs: number): Promise<void>;
  /** 보내지 않은 행 수와 가장 오래된 행의 created_at(지표 ticket_device_key_notice_backlog·oldest_seconds) */
  backlog(): Promise<{ readonly count: number; readonly oldestCreatedAtMs?: number }>;
  /** 보낸 지 olderThanMs 지난 행을 지운다(7일 [가정], docs/data.md) */
  purgeSent(beforeMs: number): Promise<number>;
}

/** core-svc 알림 내부 입구 본문(docs/features/notify.md §4.7). 정의 밖 칸은 core가 422로 거절한다 */
export interface DeviceKeyNoticeEvent {
  readonly noticeId: string;
  readonly type: DeviceKeyNoticeType;
  readonly accountId: string;
  readonly ticketId: string;
  readonly registeredAtMs: number;
}

/** 보내기 결과: sent(2xx·422) · retry(그 밖) */
export type DeviceKeyNoticeSendResult = { readonly kind: 'sent'; readonly status: number } | { readonly kind: 'retry'; readonly reason: string };

/** core-svc 알림 내부 입구로 보내는 포트(어댑터 HttpDeviceKeyNoticeSink) */
export interface DeviceKeyNoticeSink {
  send(e: DeviceKeyNoticeEvent): Promise<DeviceKeyNoticeSendResult>;
}

/** 부스 재발급 저장소(openapi createTicketBoothRequest·createScannerBoothAuthorization, docs/review/plans/F-05-12.md §4) */
export interface BoothStore {
  /** 티켓 보유자(없으면 undefined). 부스 요청의 404를 토큰 확인보다 먼저 가른다 */
  ownerOf(ticketId: string): Promise<string | undefined>;
  /** 보유자·회차 시작·하루 한도를 한 트랜잭션에서 보고 만든다. 새 코드는 옛 PENDING 코드를 무효로 한다 */
  createRequest(i: { ticketId: string; accountId: string; codeHash: string; nowMs: number; dayKey: string; expiresAtMs: number; reverificationId?: string }): Promise<BoothRequestOutcome>;
  /** 코드 해시로 활성 요청을 찾아 허용을 적는다(같은 코드를 다시 찍으면 같은 답, 사용된 코드는 410) */
  authorize(i: { eventId: string; deviceId: string; codeHash: string; nowMs: number; allowUntilMs: number }): Promise<BoothAuthorizeOutcome>;
  /** 기기 키 저장과 같은 트랜잭션에서 부르는 확인·사용 표시(tx가 있으면 그 트랜잭션, 없으면 저장소가 연다) */
  consumeForRegistration(i: { ticketId: string; boothRequestId: string; nowMs: number }, tx?: unknown): Promise<boolean>;
  /** gate_lead의 SCR-052 기기 현황 */
  gateStatus(i: { eventId: string; deviceId: string }): Promise<GateStatusView>;
  /** 그 스태프가 한 예외 통과(최신순) */
  overridePasses(i: { eventId: string; staffAccountId: string; deviceId: string; limit: number }): Promise<OverridePassView[]>;
}
export const BOOTH_STORE = Symbol('ticket.BoothStore');

export interface DeviceKeyStore {  register(i: DeviceKeyRegistrationInput): Promise<DeviceKeyRegistrationResult>;
  /** 회차의 티켓별 유효 키(keyId·압축 공개키 base64url) */
  activeKeysByEvent(eventId: string): Promise<Map<string, { keyId: string; publicKey: string }[]>>;
  /** 회차에서 폐기된 keyId(base64url) 목록 */
  revokedKeyIdsByEvent(eventId: string): Promise<string[]>;
  /** 스캔 기록의 keyId가 그 티켓의 유효 키인지 폐기됐는지 모르는지 */
  keyState(ticketId: string, keyId: Uint8Array): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'>;
}
