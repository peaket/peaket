// 양도 저장소·재인증·회원 코드 찾기 포트(BUILD_ORDER GAT-050·GAT-055). 어댑터는 application이 아니라 이 파일을 본다(architecture §3.1).
import type { CreateOfferRejection, ReturnRejection, TransferOfferRecord, TransferTicketSnapshot } from './transfer.js';

export type TransferAct = 'FAN_HIGH_RISK' | 'FAN_SENSITIVE';
export type TransferOp = 'TRANSFER_REQUEST' | 'TICKET_RETURN';

/** 재인증 토큰 확인 포트(어댑터 JwksFanReauthGate). false면 403, 던지면 503(ReauthUnavailable) */
export interface TransferReauthGate {
  verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: TransferAct; readonly op: TransferOp }): Promise<boolean>;
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
}

/** 저장소가 행 잠금 안에서 돌려주는 결과. 거절은 도메인 사유 그대로다 */
export type CreateOfferOutcome =
  | { readonly kind: 'CREATED'; readonly offer: TransferOfferRecord }
  | { readonly kind: 'REPLAYED'; readonly offer: TransferOfferRecord }
  | { readonly kind: 'REJECTED'; readonly reason: CreateOfferRejection };
export type DecideOutcome =
  | { readonly kind: 'OK'; readonly offer: TransferOfferRecord; readonly replayed: boolean }
  | { readonly kind: 'REJECTED'; readonly reason: 'NOT_FOUND' | 'NOT_RECIPIENT' | 'NOT_OFFERED' | 'EXPIRED' | 'ENTRY_STARTED' | 'NOT_SENDER' };
export type ReturnOutcome =
  | { readonly kind: 'OK'; readonly ticketId: string; readonly replayed: boolean }
  | { readonly kind: 'REJECTED'; readonly reason: ReturnRejection | 'NOT_FOUND' };

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
  accept(input: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<DecideOutcome>;
  reject(input: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<DecideOutcome>;
  withdraw(input: { readonly offerId: string; readonly accountId: string; readonly nowMs: number }): Promise<DecideOutcome>;
  returnToPayer(input: { readonly ticketId: string; readonly accountId: string; readonly nowMs: number; readonly idempotencyKey: string }): Promise<ReturnOutcome>;
  expireOffers(nowMs: number, limit: number): Promise<number>;
  setTransferLock(input: SetTransferLockInput): Promise<readonly TransferLockOutcome[]>;
  /** 그 표의 잠금이 지금 유효한가(풀림·기한·입장 시작 반영) */
  lockActive(ticketId: string, nowMs: number): Promise<boolean>;
}
