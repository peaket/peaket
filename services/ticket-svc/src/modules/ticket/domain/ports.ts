// 티켓 저장소 포트(BUILD_ORDER HOT-160). 메모리 구현은 단위 시험, Drizzle 구현은 운영 DB가 쓴다.
import type { DeviceKeyReason } from './device-key.js';
import type { CancelTicketOutcome, CancelTicketsInput, IssueTicketsInput, IssueTicketsResult, ListTicketsInput, ListTicketsResult, ReviewEligibilityTicket, TicketRecord } from './ticket.js';

/** 발권 저장 입력: 앱이 만든 멱등 지문을 함께 넘긴다. */
export interface IssueStoreInput extends IssueTicketsInput {
  readonly fingerprint: string;
}

export interface TicketStore {
  /**
   * 주문·세대 단위로 한 번만 발권한다. 같은 주문·세대의 재요청이면 처음 티켓을 그대로 돌려주고 replayed=true다.
   * 같은 주문·세대에 다른 내용(지문)이면 TicketConflictError다.
   * @param candidates 새로 만들 때 저장할 티켓(키 원문 포함)
   */
  issue(input: IssueStoreInput, candidates: readonly TicketRecord[]): Promise<IssueTicketsResult>;

  /** 티켓마다 행 잠금 안에서 조건을 보고 취소한다. cancellation_id·ticket_id 단위로 멱등하다. */
  cancel(input: CancelTicketsInput): Promise<readonly CancelTicketOutcome[]>;

  /** 계정의 월렛 목록. 발권 최신순, 커서 페이지. */
  list(input: ListTicketsInput): Promise<ListTicketsResult>;

  /** 후기 자격 판정에 쓰는 그 회차의 티켓(모든 계정·상태). 결제자·유효 상태는 도메인이 가른다(BAT-585) */
  listReviewEligibility(eventId: string): Promise<readonly ReviewEligibilityTicket[]>;
}

export interface DeviceKeyRegistrationInput {
  readonly ticketId: string;
  readonly accountId: string;
  readonly keyId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly reason: DeviceKeyReason;
  readonly nowMs: number;
  /** 재인증을 확인했는가. 입장 시작 뒤 ISSUE와 반복 ISSUE의 허용 근거다 */
  readonly reauthVerified: boolean;
}

export type DeviceKeyRegistrationResult =
  | { readonly kind: 'REGISTERED'; readonly keyId: string; readonly revokedKeyId?: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_HOLDER' }
  | { readonly kind: 'REAUTH_REQUIRED' }
  | { readonly kind: 'ENTRY_STARTED' }
  | { readonly kind: 'REISSUE_LIMIT' }
  /** 보유자가 결제자 그대로인데 TRANSFER를 부른 경우(양도 수락 전) */
  | { readonly kind: 'TRANSFER_NOT_ALLOWED' };

export interface DeviceKeyStore {
  register(i: DeviceKeyRegistrationInput): Promise<DeviceKeyRegistrationResult>;
  /** 회차의 티켓별 유효 키(keyId·압축 공개키 base64url) */
  activeKeysByEvent(eventId: string): Promise<Map<string, { keyId: string; publicKey: string }[]>>;
  /** 회차에서 폐기된 keyId(base64url) 목록 */
  revokedKeyIdsByEvent(eventId: string): Promise<string[]>;
  /** 스캔 기록의 keyId가 그 티켓의 유효 키인지 폐기됐는지 모르는지 */
  keyState(ticketId: string, keyId: Uint8Array): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'>;
}
