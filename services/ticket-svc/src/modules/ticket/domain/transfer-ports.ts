// 양도 저장소·재인증·회원 코드 찾기 포트(BUILD_ORDER GAT-050·GAT-055). 재인증 확인 포트는 기기 키 등록도 쓴다(GAT-020, ADR-0363 결정 1). 어댑터는 application이 아니라 이 파일을 본다(architecture §3.1).
import type { CreateOfferRejection, ReturnRejection, TransferCursor, TransferOfferRecord, TransferStatus, TransferTicketSnapshot } from './transfer.js';
import type { PublicWithdrawReason } from './transfer.js';
import type { TransferNoticeParty, TransferNoticeType } from './transfer-notice.js';

export type TransferAct = 'FAN_HIGH_RISK' | 'FAN_SENSITIVE';
/** 받는 쪽 작업(authz-matrix §6). DEVICE_KEY_ISSUE는 기기 키 등록(재발급·입장 시작 뒤 첫 등록, ADR-0363 결정 1)이 쓴다 */
export type TransferOp = 'TRANSFER_REQUEST' | 'TICKET_RETURN' | 'DEVICE_KEY_ISSUE';

/** 재인증 토큰 확인 포트(어댑터 JwksFanReauthGate). false면 403, 던지면 503(ReauthUnavailable) */
export interface TransferReauthGate {
  verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: TransferAct; readonly op: TransferOp }): Promise<boolean>;
  /** 약한 재인증('requested')을 가르기 위한 선택 면. 없으면 verify만 쓴다(기존 짝 가짜) */
  verifyDetailed?(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: TransferAct; readonly op: TransferOp }): Promise<{ readonly ok: boolean; readonly strength?: 'verified' | 'requested' }>;
}

/** 재인증을 확인하지 못했다(공개키 묶음·jti 저장소 장애). 503 reauth-unavailable */
export class ReauthUnavailable extends Error {
  constructor(message: string, o?: { cause?: unknown }) {
    super(message, o);
    this.name = 'ReauthUnavailable';
  }
}

/** 회원 코드 찾기(identity MemberCodeService). 없으면 UNAVAILABLE, 찾는 코드가 없으면 undefined */
export interface MemberCodeDirectory {
  resolveMemberCode(code: string): Promise<{ readonly accountId: string; readonly nickname: string } | undefined>;
  /** 정규화한 숫자만 받는다(010…). identity가 ACTIVE 계정의 phone을 정확히 같은 식으로 맞춘다 */
  resolvePhone?(phoneDigits: string): Promise<{ readonly accountId: string; readonly nickname: string } | undefined>;
  resolveNicknames?(accountIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** 저장소가 행 잠금 안에서 돌려주는 결과. 거절은 도메인 사유 그대로다 */
export type CreateOfferOutcome =
  | { readonly kind: 'CREATED'; readonly offer: TransferOfferRecord }
  | { readonly kind: 'REPLAYED'; readonly offer: TransferOfferRecord }
  | { readonly kind: 'REJECTED'; readonly reason: CreateOfferRejection };
export type DecideOutcome =
  | { readonly kind: 'OK'; readonly offer: TransferOfferRecord; readonly replayed: boolean }
  | { readonly kind: 'REJECTED'; readonly reason: 'NOT_FOUND' | 'NOT_RECIPIENT' | 'NOT_OFFERED' | 'EXPIRED' | 'ENTRY_STARTED' | 'NOT_SENDER' | 'ALREADY_ENDED' };
export type ReturnOutcome =
  | { readonly kind: 'OK'; readonly ticketId: string; readonly replayed: boolean }
  | { readonly kind: 'REJECTED'; readonly reason: ReturnRejection | 'NOT_FOUND' }
  /** 같은 계정이 같은 Idempotency-Key로 다른 표를 돌려주려 했다(guidelines §4 다른 본문, 422) */
  | { readonly kind: 'REJECTED'; readonly reason: 'IDEMPOTENCY_KEY_REUSED' };

/** 받는 사람 조회 기록 결과(0018 transfer_recipient_lookup.result) */
export type RecipientLookupResult = 'FOUND' | 'NOT_FOUND' | 'LIMITED' | 'UNAVAILABLE';
export type RecipientLookupClaim = { readonly kind: 'ALLOWED'; readonly lookupId: string } | { readonly kind: 'LIMITED'; readonly retryAfterSeconds: number };

/** 받은 요청 목록 한 줄(회차 ID는 ticket에서 읽어 붙인다) */
export interface TransferOfferListRow extends TransferOfferRecord {
  readonly eventId: string;
}

export interface ListTransfersInput {
  readonly recipientAccountId: string;
  readonly statuses: readonly TransferStatus[];
  readonly cursor?: TransferCursor;
  readonly limit: number;
}
export interface ListTransfersResult {
  readonly offers: readonly TransferOfferListRow[];
  readonly nextCursor?: TransferCursor;
}

export interface TransferLockOutcome {
  readonly ticketId: string;
  readonly result: 'LOCKED' | 'UNLOCKED' | 'OTHER_CASE' | 'ENTRY_STARTED' | 'TICKET_CLOSED' | 'UNCHANGED';
  readonly withdrawnOfferId?: string;
  readonly holderAccountId?: string;
}

export interface SetTransferLockInput {
  readonly caseId: string;
  readonly version: number;
  readonly locked: boolean;
  readonly eventId: string;
  readonly accountIds: readonly string[];
  readonly expiresAtMs?: number;
  readonly nowMs: number;
}

/** 양도 저장 포트. 메모리 구현은 단위 시험, Drizzle 구현은 운영 DB가 쓴다 */
export interface TransferStore {
  ticket(ticketId: string): Promise<TransferTicketSnapshot | undefined>;
  /** 그 회차·결제자에 지금 유효한 잠금(입장 시작·기한 지남은 없다) */
  activeTransferLock(eventId: string, payerAccountId: string, nowMs: number): Promise<{ readonly caseId: string; readonly expiresAtMs: number } | undefined>;
  createOffer(offer: TransferOfferRecord, nowMs: number): Promise<CreateOfferOutcome>;
  getOffer(offerId: string): Promise<TransferOfferRecord | undefined>;
  /** 그 표의 지금 OFFERED 요청(최대 하나, transfer_offer_open_key). 상세·목록의 pendingTransfer가 쓴다 */
  openOffer(ticketId: string): Promise<TransferOfferRecord | undefined>;
  /** 받는 사람이 그 계정인 요청만 최근 순(만든 시각 내림차순, 같으면 ID 내림차순). 커서 페이지 */
  listOffers(input: ListTransfersInput): Promise<ListTransfersResult>;
  accept(input: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<DecideOutcome>;
  reject(input: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<DecideOutcome>;
  withdraw(input: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<DecideOutcome>;
  returnToPayer(input: { readonly ticketId: string; readonly accountId: string; readonly nowMs: number; readonly idempotencyKey: string }): Promise<ReturnOutcome>;
  /**
   * 받는 사람 조회 시도 하나를 창 안에서 세고 기록을 먼저 쓴다(닫힌 쪽). 한도면 LIMITED 행을 남기고 몇 초 뒤 풀리는지 준다.
   * 기록 쓰기가 실패하면 던진다(application이 503으로 바꾸고 identity를 부르지 않는다). 쓰인 행은 UNAVAILABLE로 시작하고 finishLookup이 결과를 쓴다
   */
  claimLookup(input: { readonly accountId: string; readonly nowMs: number; readonly windowMs: number; readonly limit: number }): Promise<RecipientLookupClaim>;
  finishLookup(lookupId: string, result: RecipientLookupResult): Promise<void>;
  expireOffers(nowMs: number, limit: number): Promise<number>;
  setTransferLock(input: SetTransferLockInput): Promise<readonly TransferLockOutcome[]>;
  /** 그 표의 잠금이 지금 유효한가(풀림·기한·입장 시작 반영) */
  lockActive(ticketId: string, nowMs: number): Promise<boolean>;
  /** 그 회차 OFFERED 요청을 모두 WITHDRAWN·EVENT_POSTPONED로 바꾸고 표시를 되돌린다(멱등) */
  withdrawForEvent?(i: { readonly eventId: string; readonly reason: 'EVENT_POSTPONED'; readonly nowMs: number }): Promise<{ readonly withdrawn: readonly string[] }>;
  /** 탈퇴 참여자가 정리할 것: 받은 표·보낸 요청·받은 요청 */
  accountTransfers?(i: { readonly accountId: string }): Promise<{ readonly heldReceived: readonly string[]; readonly sentOffers: readonly string[]; readonly receivedOffers: readonly string[] }>;
  /** 받은 표를 결제자에게 돌려준다. 동결 중이면 키만 폐기하고 FROZEN */
  returnForAccount?(i: { readonly ticketId: string; readonly accountId: string; readonly nowMs: number }): Promise<'RETURNED' | 'FROZEN'>;
  withdrawForAccount?(i: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<void>;
  rejectForAccount?(i: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<void>;
}

/** 알림 보내기 반복이 잡는 행(transfer_notice) */
export interface StoredTransferNotice {
  readonly noticeId: string;
  readonly type: TransferNoticeType;
  readonly party: TransferNoticeParty;
  readonly offerId: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly reason?: PublicWithdrawReason;
  readonly createdAtMs: number;
  readonly attempts: number;
}

export interface TransferNoticeStore {
  claimDue(nowMs: number, limit: number, leaseMs: number): Promise<readonly StoredTransferNotice[]>;
  markSent(noticeId: string, nowMs: number): Promise<void>;
  reschedule(noticeId: string, nextAttemptAtMs: number): Promise<void>;
  purgeSent(beforeMs: number): Promise<number>;
  backlog(): Promise<{ readonly count: number; readonly oldestCreatedAtMs?: number }>;
}
