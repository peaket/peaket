// 양도·돌려주기의 순수 규칙(BUILD_ORDER GAT-050·GAT-055, docs/features/transfer-refund.md §3.1·§4·§4.1).
// 저장소·HTTP와 떼어 시험한다. 시각은 모두 epoch ms이고, 입장 시작은 ticket-svc가 아는 event_starts_at을 쓴다
// (core entry_start_at 연결은 GAT-180 앞이라 남는 한계다).
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import type { TicketStatus } from './ticket.js';

/** 양도 요청 기한(POL-017): 요청 + 48시간과 양도 마감 가운데 이른 때 */
export const TRANSFER_OFFER_TTL_MS = 48 * 60 * 60 * 1000;
/** 양도 마감: 공연 시작 2시간 전(POL-017) */
export const TRANSFER_MARKET_CLOSE_MS = 2 * 60 * 60 * 1000;
/** 받는 사람 참조(recipientRef) 수명 10분 [가정](docs/features/transfer-refund.md §4) */
export const RECIPIENT_REF_TTL_MS = 10 * 60 * 1000;

export type TransferStatus = 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'RECLAIMED';
export type TransferWithdrawReason = 'SENDER' | 'ACCOUNT_DELETED' | 'DEPOSIT_ERROR' | 'EVENT_CANCELLED' | 'EVENT_POSTPONED' | 'FRAUD_LOCK';
/** 받는 사람에게 보이는 철회 까닭(openapi TransferOffer.withdrawReason). 부정 예매·탈퇴·입금 오류는 OTHER로 가린다(transfer-refund §4.1) */
export type PublicWithdrawReason = 'SENDER' | 'EVENT_CANCELLED' | 'EVENT_POSTPONED' | 'OTHER';
export function publicWithdrawReasonOf(reason: TransferWithdrawReason | undefined): PublicWithdrawReason {
  switch (reason) {
    case 'SENDER':
      return 'SENDER';
    case 'EVENT_CANCELLED':
      return 'EVENT_CANCELLED';
    case 'EVENT_POSTPONED':
      return 'EVENT_POSTPONED';
    default:
      return 'OTHER';
  }
}

/** 양도 요청 한 줄(docs/data.md `transfer_offer`). `offerId`는 요청의 Idempotency-Key다 */
export interface TransferOfferRecord {
  readonly offerId: string;
  readonly ticketId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly status: TransferStatus;
  readonly withdrawReason?: TransferWithdrawReason;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
  readonly decidedAtMs?: number;
}

/** 판정에 쓰는 티켓의 칸만. 저장소가 행 잠금 안에서 읽어 넘긴다 */
export interface TransferTicketSnapshot {
  readonly ticketId: string;
  readonly accountId: string;
  readonly payerAccountId: string;
  readonly eventId: string;
  readonly status: TicketStatus;
  readonly transferPending: boolean;
  readonly eventStartsAtMs?: number;
  readonly fraudLockCaseId?: string;
  readonly fraudLockVersion?: number;
  /** 월렛 목록과 상세가 같은 값을 싣도록 저장소가 넘긴다 */
  readonly gateZone?: string;
}

/** 상세(GET /v1/tickets/{ticketId})가 싣는 칸(openapi Ticket). 좌석 이름·예매번호·주문 상세·판매자는 범위 밖이다 */
export interface TicketDetailView {
  readonly ticketId: string;
  readonly eventId: string;
  readonly status: TicketStatus;
  readonly transferable: boolean;
  readonly transferLocked: boolean;
  readonly transferLockExpiresAt: string | null;
  readonly transferDeadline?: string;
  readonly cancelDeadline?: string;
  readonly eventStartsAt?: string;
  readonly gateZone?: string;
  /** 받은 표의 보낸 분 닉네임. 원천이 없어 지금은 가린 값(뒤 몫 F-05-11) */
  readonly receivedFromNickname: string | null;
  readonly pendingTransfer: { readonly offerId: string; readonly expiresAt: string } | null;
}

/** 받은 표의 보낸 분 자리(닉네임 원천이 없다, 계획 §6-8) */
export const RECEIVED_FROM_MASKED = '회*';

/**
 * 상세 한 장. 양도 가능은 상품 양도 가능(원천 없음 → 참)·결제자 보유·마감 전·입장 시작 전·진행 중 요청 없음·잠금 없음이다.
 * 잠금·요청 칸은 보유자가 결제자일 때만 싣는다(받은 사람에게 결제자 사정을 보이지 않는다, transfer-refund §4.1).
 */
export function ticketDetailOf(
  t: TransferTicketSnapshot,
  o: {
    readonly nowMs: number;
    readonly openOffer?: { readonly offerId: string; readonly expiresAtMs: number };
    readonly lockActive: boolean;
    readonly lockExpiresAtMs?: number;
  },
): TicketDetailView {
  const starts = t.eventStartsAtMs;
  const close = marketCloseAtMs(starts);
  const payerHolds = t.accountId === t.payerAccountId;
  const ended = ENDED_STATUSES.has(t.status);
  const beforeStart = beforeEntryStart(starts, o.nowMs);
  const pendingOffer = payerHolds && o.openOffer !== undefined && o.openOffer.expiresAtMs > o.nowMs ? o.openOffer : undefined;
  const transferable =
    payerHolds &&
    !ended &&
    beforeStart &&
    (close === undefined || o.nowMs < close) &&
    !t.transferPending &&
    t.status !== 'TRANSFER_PENDING' &&
    !o.lockActive &&
    pendingOffer === undefined;
  const locked = payerHolds && o.lockActive;
  return {
    ticketId: t.ticketId,
    eventId: t.eventId,
    status: t.status,
    transferable,
    transferLocked: locked,
    transferLockExpiresAt: locked && o.lockExpiresAtMs !== undefined ? new Date(o.lockExpiresAtMs).toISOString() : null,
    ...(close === undefined ? {} : { transferDeadline: new Date(close).toISOString() }),
    ...(starts === undefined ? {} : { cancelDeadline: new Date(starts).toISOString(), eventStartsAt: new Date(starts).toISOString() }),
    ...(t.gateZone === undefined || t.gateZone.trim() === '' ? {} : { gateZone: t.gateZone }),
    receivedFromNickname: payerHolds ? null : RECEIVED_FROM_MASKED,
    pendingTransfer: pendingOffer === undefined ? null : { offerId: pendingOffer.offerId, expiresAt: new Date(pendingOffer.expiresAtMs).toISOString() },
  };
}

/** 양도 마감 시각. 회차 시작 시각을 모르면 기한은 48시간만 본다 */
export function marketCloseAtMs(eventStartsAtMs: number | undefined): number | undefined {
  return eventStartsAtMs === undefined ? undefined : eventStartsAtMs - TRANSFER_MARKET_CLOSE_MS;
}

/** 받은 요청 목록 커서(`[만든 ms, 요청 ID]` JSON의 base64url). guidelines §3 불투명 커서 */
export interface TransferCursor {
  readonly createdAtMs: number;
  readonly offerId: string;
}
export function transferCursorOf(c: TransferCursor): string {
  return Buffer.from(JSON.stringify([c.createdAtMs, c.offerId]), 'utf8').toString('base64url');
}
/** JavaScript Date가 담을 수 있는 최대 ms(8.64e15). 넘으면 new Date·PostgreSQL timestamptz가 던진다 */
const MAX_DATE_MS = 8_640_000_000_000_000;
const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseTransferCursor(raw: string | undefined): TransferCursor | undefined {
  if (raw === undefined || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) return undefined;
    if (typeof v[0] !== 'number' || !Number.isSafeInteger(v[0]) || v[0] < 0 || v[0] > MAX_DATE_MS) return undefined;
    if (typeof v[1] !== 'string' || !CURSOR_UUID.test(v[1])) return undefined;
    return { createdAtMs: v[0], offerId: v[1].toLowerCase() };
  } catch {
    return undefined;
  }
}

/** 요청 기한 = min(지금 + 48시간, 양도 마감). 마감이 없으면 48시간 */
export function offerExpiryMs(nowMs: number, eventStartsAtMs: number | undefined): number {
  const close = marketCloseAtMs(eventStartsAtMs);
  return close === undefined ? nowMs + TRANSFER_OFFER_TTL_MS : Math.min(nowMs + TRANSFER_OFFER_TTL_MS, close);
}

/** 입장 시작(공연 시작) 전인가. ticket-svc는 입장 시작을 event_starts_at으로 안다 */
export function beforeEntryStart(eventStartsAtMs: number | undefined, nowMs: number): boolean {
  return eventStartsAtMs === undefined || nowMs < eventStartsAtMs;
}

/** 끝난 표(환급·무효·취소 접수·부정 표시). 양도·돌려주기 대상이 아니다 */
export const ENDED_STATUSES: ReadonlySet<TicketStatus> = new Set(['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED']);

export type CreateOfferRejection =
  | 'NOT_HOLDER'
  | 'SELF_TRANSFER'
  | 'REOFFER'
  | 'ENTRY_STARTED'
  | 'TRANSFER_CLOSED'
  | 'TRANSFER_LOCKED'
  | 'TRANSFER_PENDING'
  | 'ALREADY_ENDED';

/**
 * 양도 요청을 만들 수 있는가(§3.1 허용 조건, §4.1 잠금). 차례: 찾기 → 재양도 → 끝남 → 입장 시작 → 마감 → 잠금 → 진행 중.
 * 받은 표(보유자 ≠ 결제자)를 결제자가 다시 요청하면 REOFFER(409), 다른 사람이 부르면 NOT_HOLDER(404)다.
 */
export function createOfferRejectionOf(
  t: TransferTicketSnapshot,
  o: { readonly callerAccountId: string; readonly recipientAccountId?: string; readonly nowMs: number; readonly lockActive: boolean },
): CreateOfferRejection | undefined {
  // 보유자·결제자 검사가 먼저다. 비보유자가 자기에게 보내는 요청도 남의 표를 남에게 보내는 요청과 같은 404여야
  // 티켓 ID를 아는 사람이 422/404로 표 존재를 가르지 않는다(authz-matrix §4.1·§5.2).
  if (t.accountId !== o.callerAccountId) return t.payerAccountId === o.callerAccountId ? 'REOFFER' : 'NOT_HOLDER';
  if (t.payerAccountId !== o.callerAccountId) return 'REOFFER';
  // 자기 양도는 받는 사람 참조가 자기 계정이어도 막는다(수락이 자기 키를 폐기하고 ISSUE 첫 등록으로 재인증·24시간 통제를 우회하는 길)
  if (o.recipientAccountId !== undefined && o.recipientAccountId === o.callerAccountId) return 'SELF_TRANSFER';
  if (ENDED_STATUSES.has(t.status)) return 'ALREADY_ENDED';
  if (!beforeEntryStart(t.eventStartsAtMs, o.nowMs)) return 'ENTRY_STARTED';
  const close = marketCloseAtMs(t.eventStartsAtMs);
  if (close !== undefined && o.nowMs >= close) return 'TRANSFER_CLOSED';
  // 잠금 판정은 지금 유효한 잠금(기한·입장 시작 반영)만 본다. 기한이 지난 사건 ID가 칸에 남아 있어도 잠금이 아니다(§4.1)
  if (o.lockActive) return 'TRANSFER_LOCKED';
  if (t.transferPending || t.status === 'TRANSFER_PENDING') return 'TRANSFER_PENDING';
  return undefined;
}

export type AcceptRejection = 'NOT_RECIPIENT' | 'NOT_OFFERED' | 'EXPIRED' | 'ENTRY_STARTED';

/** 받는 사람이 수락할 수 있는가. 이미 수락된 요청은 재생(성공)이고, 만료된 요청은 수락할 수 없다(R-T1) */
export function acceptRejectionOf(
  offer: TransferOfferRecord,
  o: { readonly accountId: string; readonly nowMs: number; readonly eventStartsAtMs: number | undefined },
): AcceptRejection | undefined {
  if (offer.fromAccountId === offer.toAccountId) return 'NOT_OFFERED';
  if (offer.toAccountId !== o.accountId) return 'NOT_RECIPIENT';
  if (offer.status === 'ACCEPTED') return undefined;
  if (offer.status === 'EXPIRED') return 'EXPIRED';
  if (offer.status !== 'OFFERED') return 'NOT_OFFERED';
  if (o.nowMs >= offer.expiresAtMs) return 'EXPIRED';
  if (!beforeEntryStart(o.eventStartsAtMs, o.nowMs)) return 'ENTRY_STARTED';
  return undefined;
}

export type RejectRejection = 'NOT_RECIPIENT' | 'NOT_OFFERED' | 'EXPIRED' | 'ENTRY_STARTED';

/** 받는 사람이 거절할 수 있는가. 이미 거절된 요청은 재생(성공)이다(R-T21 ①) */
export function rejectRejectionOf(
  offer: TransferOfferRecord,
  o: { readonly accountId: string; readonly nowMs: number; readonly eventStartsAtMs: number | undefined },
): RejectRejection | undefined {
  if (offer.toAccountId !== o.accountId) return 'NOT_RECIPIENT';
  if (offer.status === 'REJECTED') return undefined;
  if (offer.status === 'EXPIRED') return 'EXPIRED';
  if (offer.status !== 'OFFERED') return 'NOT_OFFERED';
  if (o.nowMs >= offer.expiresAtMs) return 'EXPIRED';
  if (!beforeEntryStart(o.eventStartsAtMs, o.nowMs)) return 'ENTRY_STARTED';
  return undefined;
}

export type WithdrawRejection = 'NOT_SENDER' | 'NOT_OFFERED';

/** 보낸 사람이 철회할 수 있는가. 이미 철회된 요청은 재생(성공)이다(R-T21 ①) */
export function withdrawRejectionOf(offer: TransferOfferRecord, o: { readonly accountId: string; readonly nowMs: number }): WithdrawRejection | undefined {
  if (offer.fromAccountId !== o.accountId) return 'NOT_SENDER';
  if (offer.status === 'WITHDRAWN') return undefined;
  if (offer.status !== 'OFFERED' && offer.status !== 'EXPIRED') return 'NOT_OFFERED';
  return undefined;
}

export type ReturnRejection = 'NOT_HOLDER' | 'PAYER_HOLDS' | 'ENTRY_STARTED' | 'ENTRY_RECORDED' | 'ALREADY_ENDED';

/**
 * 받은 보유자가 결제자에게 돌려줄 수 있는가(§3.1, R-T17). 결제자 본인이면 PAYER_HOLDS, 입장 시작 뒤는 ENTRY_STARTED,
 * 입장 기록이 있으면 ENTRY_RECORDED다. 부정 예매 양도 잠금은 막지 않는다(ADR-0173 결정 3).
 */
export function returnRejectionOf(
  t: TransferTicketSnapshot,
  o: { readonly accountId: string; readonly nowMs: number; readonly eventStartsAtMs: number | undefined; readonly entryRecorded: boolean },
): ReturnRejection | undefined {
  if (t.accountId !== o.accountId) return 'NOT_HOLDER';
  if (t.accountId === t.payerAccountId) return 'PAYER_HOLDS';
  if (ENDED_STATUSES.has(t.status)) return 'ALREADY_ENDED';
  if (!beforeEntryStart(o.eventStartsAtMs, o.nowMs)) return 'ENTRY_STARTED';
  if (o.entryRecorded) return 'ENTRY_RECORDED';
  return undefined;
}

// ---- 받는 사람 참조(recipientRef) ----
// 서버가 10분짜리 암호문 참조를 만들고, 양도 요청은 그 참조만 받는다. 계정 ID가 그대로 드러나지 않게 AES-256-GCM으로 감싼다(RV-03).

interface RefPayload {
  readonly a: string;
  readonly e: number;
}

/** 비밀에서 32바이트 키를 만든다(서비스마다 다른 값, Secrets Manager) */
function recipientRefKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** 계정 ID·만료 시각을 AES-256-GCM으로 감싼 불투명 참조(iv‖암호문‖tag, base64url)를 만든다 */
export function signRecipientRef(o: { readonly secret: string; readonly accountId: string; readonly expiresAtMs: number }): string {
  const iv = Buffer.from(createHash('sha256').update(`${o.secret}:iv:${o.accountId}:${o.expiresAtMs}`, 'utf8').digest().subarray(0, 12));
  const cipher = createCipheriv('aes-256-gcm', recipientRefKey(o.secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ a: o.accountId, e: o.expiresAtMs } satisfies RefPayload), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** 참조를 풀어 계정 ID를 돌려준다. 만료(지금 ≥ e)·변조·모양 오류는 undefined */
export function verifyRecipientRef(ref: string, o: { readonly secret: string; readonly nowMs: number }): string | undefined {
  const parts = ref.split('.');
  if (parts.length !== 3) return undefined;
  const [ivText, bodyText, tagText] = parts as [string, string, string];
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', recipientRefKey(o.secret), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    plain = Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { a, e } = parsed as { a?: unknown; e?: unknown };
  if (typeof a !== 'string' || typeof e !== 'number' || !Number.isFinite(e)) return undefined;
  if (o.nowMs >= e) return undefined;
  return a;
}

// ---- 부정 예매 양도 잠금(TransferLockService, ADR-0171·ADR-0173) ----

export type TransferLockResult = 'LOCKED' | 'UNLOCKED' | 'OTHER_CASE' | 'ENTRY_STARTED' | 'TICKET_CLOSED' | 'UNCHANGED';

/**
 * 잠금을 이 표에 반영할지 가른다. 차례: 끝난 표 → 다른 사건 → 입장 시작(잠글 때만) → 이미 같은 판 이상.
 * 같은 사건의 더 큰 판만 반영하고, 같거나 작은 판은 아무것도 바꾸지 않는다(멱등, R-T31 ④).
 */
export function lockResultOf(
  t: TransferTicketSnapshot,
  o: { readonly caseId: string; readonly version: number; readonly locked: boolean; readonly nowMs: number; readonly entryRecorded: boolean },
): TransferLockResult {
  if (ENDED_STATUSES.has(t.status)) return 'TICKET_CLOSED';
  if (t.fraudLockCaseId !== undefined && t.fraudLockCaseId !== o.caseId) return 'OTHER_CASE';
  if (o.locked && !beforeEntryStart(t.eventStartsAtMs, o.nowMs)) return 'ENTRY_STARTED';
  if (t.fraudLockCaseId === o.caseId && (t.fraudLockVersion ?? 0) >= o.version) return 'UNCHANGED';
  if (!o.locked && t.fraudLockCaseId === undefined) return 'UNCHANGED';
  return o.locked ? 'LOCKED' : 'UNLOCKED';
}

/** 잠금이 지금 유효한가. 풀림(false)·최대 기한 도과·입장 시작은 유효하지 않다(ticket-svc가 스스로 푼다, R-T31 ⑨⑩) */
export function lockActiveAt(o: { readonly locked: boolean; readonly expiresAtMs: number; readonly nowMs: number; readonly eventStartsAtMs: number | undefined }): boolean {
  if (!o.locked) return false;
  if (o.nowMs >= o.expiresAtMs) return false;
  return beforeEntryStart(o.eventStartsAtMs, o.nowMs);
}
