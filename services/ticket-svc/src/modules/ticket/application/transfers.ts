// 양도·돌려주기 유스케이스(BUILD_ORDER GAT-050·GAT-055, docs/features/transfer-refund.md §3.1·§4·§4.1).
// 입력 검사·재인증·받는 사람 참조 확인은 여기서, 행 잠금 안의 상태 재확인·보유자 변경·키 폐기는 저장소가 한다.
import type { Clock } from '@peaket/platform';
import {
  type CreateOfferRejection,
  offerExpiryMs,
  type ReturnRejection,
  signRecipientRef,
  verifyRecipientRef,
  RECIPIENT_REF_TTL_MS,
  type TransferOfferRecord,
  type TransferStatus,
} from '../domain/transfer.js';

export type {
  CreateOfferOutcome,
  DecideOutcome,
  MemberCodeDirectory,
  ReauthUnavailable,
  ReturnOutcome,
  SetTransferLockInput,
  TransferAct,
  TransferLockOutcome,
  TransferOp,
  TransferReauthGate,
  TransferStore,
} from '../domain/transfer-ports.js';
import {
  type MemberCodeDirectory,
  ReauthUnavailable,
  type SetTransferLockInput,
  type TransferAct,
  type TransferLockOutcome,
  type TransferOp,
  type TransferReauthGate,
  type TransferStore,
} from '../domain/transfer-ports.js';

export type TransferErrorCode =
  | 'NOT_FOUND'
  | 'REAUTH_REQUIRED'
  | 'REAUTH_UNAVAILABLE'
  | 'TRANSFER_LOCKED'
  | 'ENTRY_STARTED'
  | 'TRANSFER_CLOSED'
  | 'REOFFER'
  | 'TRANSFER_PENDING'
  | 'ALREADY_ENDED'
  | 'EXPIRED'
  | 'NOT_OFFERED'
  | 'PAYER_HOLDS'
  | 'ENTRY_RECORDED'
  | 'INVALID_INPUT'
  | 'RECIPIENT_NOT_FOUND'
  | 'UNAVAILABLE';

export class TransferError extends Error {
  constructor(readonly code: TransferErrorCode) {
    super(`양도 처리 오류: ${code}`);
    this.name = 'TransferError';
  }
}

export interface TransferOfferView {
  readonly offerId: string;
  readonly ticketId: string;
  readonly role: 'SENDER' | 'RECIPIENT';
  readonly status: TransferStatus;
  readonly expiresAt: string;
  readonly eventId: string;
}

export interface TransfersDeps {
  readonly store: TransferStore;
  readonly reauth: TransferReauthGate;
  readonly recipientRefSecret: string;
  readonly clock: Clock;
  readonly directory: MemberCodeDirectory;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function requireUuid(name: string, v: string | undefined): string {
  const t = (v ?? '').trim().toLowerCase();
  if (!UUID.test(t)) throw new TransferError('INVALID_INPUT');
  return t;
}
/** 회원 코드: 앞뒤 공백을 지우고 대문자로 맞춘다(가운뎃줄은 그대로) */
export function normalizeMemberCode(v: string): string {
  return v.trim().toUpperCase();
}
/** 닉네임 일부만 보인다(첫 글자 + 가운데 별). 빈 값이면 '회원' */
export function maskNickname(nickname: string): string {
  const t = nickname.trim();
  if (t === '') return '회원';
  const chars = [...t];
  const first = chars[0] ?? '';
  if (chars.length === 1) return `${first}*`;
  return `${first}${'*'.repeat(Math.min(3, chars.length - 1))}`;
}

export class Transfers {
  constructor(private readonly d: TransfersDeps) {}

  /** 받는 사람 찾기(회원 코드만). 없으면 RECIPIENT_NOT_FOUND, identity를 못 부르면 UNAVAILABLE */
  async lookupRecipient(i: { readonly memberCode?: string; readonly phoneNumber?: string; readonly nowMs?: number }): Promise<{ readonly recipientRef: string; readonly nicknameMasked: string }> {
    if (i.phoneNumber !== undefined && i.phoneNumber.trim() !== '') throw new TransferError('RECIPIENT_NOT_FOUND');
    const code = i.memberCode === undefined ? '' : normalizeMemberCode(i.memberCode);
    if (code === '') throw new TransferError('INVALID_INPUT');
    const found = await this.d.directory.resolveMemberCode(code);
    if (!found) throw new TransferError('RECIPIENT_NOT_FOUND');
    const nowMs = i.nowMs ?? this.d.clock.now();
    return {
      recipientRef: signRecipientRef({ secret: this.d.recipientRefSecret, accountId: found.accountId, expiresAtMs: nowMs + RECIPIENT_REF_TTL_MS }),
      nicknameMasked: maskNickname(found.nickname),
    };
  }

  /** 양도 요청. 재인증(FAN_HIGH_RISK/TRANSFER_REQUEST) → 받는 사람 참조 → 행 잠금 안 판정 */
  async createOffer(i: {
    readonly ticketId: string;
    readonly accountId: string;
    readonly sessionId: string;
    readonly reauthToken?: string;
    readonly recipientRef: string;
    readonly idempotencyKey: string;
  }): Promise<TransferOfferView> {
    const ticketId = requireUuid('ticketId', i.ticketId);
    const offerId = requireUuid('idempotencyKey', i.idempotencyKey);
    const accountId = requireUuid('accountId', i.accountId);
    const nowMs = this.d.clock.now();
    await this.#reauth(i.reauthToken, { accountId, sessionId: i.sessionId }, 'FAN_HIGH_RISK', 'TRANSFER_REQUEST');
    const toAccountId = verifyRecipientRef(i.recipientRef, { secret: this.d.recipientRefSecret, nowMs });
    if (toAccountId === undefined) throw new TransferError('INVALID_INPUT');
    const t = await this.d.store.ticket(ticketId);
    if (!t) throw new TransferError('NOT_FOUND');
    // 기한 지난 요청·잠금·재양도·마감 판정은 저장소가 행 잠금 안에서 다시 본다(여기서 미리 보면 만료 정비 전 값을 보고 틀릴 수 있다)
    const offer: TransferOfferRecord = {
      offerId,
      ticketId,
      fromAccountId: accountId,
      toAccountId,
      status: 'OFFERED',
      expiresAtMs: offerExpiryMs(nowMs, t.eventStartsAtMs),
      createdAtMs: nowMs,
    };
    const out = await this.d.store.createOffer(offer, nowMs);
    if (out.kind === 'REJECTED') throw new TransferError(errorOfCreate(out.reason));
    return this.#view(out.offer, accountId);
  }

  async getOffer(i: { readonly offerId: string; readonly accountId: string }): Promise<TransferOfferView> {
    const offerId = requireUuid('offerId', i.offerId);
    const accountId = requireUuid('accountId', i.accountId);
    const offer = await this.d.store.getOffer(offerId);
    if (!offer || (offer.fromAccountId !== accountId && offer.toAccountId !== accountId)) throw new TransferError('NOT_FOUND');
    return this.#view(offer, accountId);
  }

  async accept(i: { readonly offerId: string; readonly accountId: string; readonly idempotencyKey?: string }): Promise<TransferOfferView> {
    const offerId = requireUuid('offerId', i.offerId);
    const accountId = requireUuid('accountId', i.accountId);
    const out = await this.d.store.accept({ offerId, accountId, nowMs: this.d.clock.now() });
    if (out.kind === 'REJECTED') throw new TransferError(errorOfDecide(out.reason));
    return this.#view(out.offer, accountId);
  }

  async reject(i: { readonly offerId: string; readonly accountId: string; readonly idempotencyKey?: string }): Promise<TransferOfferView> {
    const offerId = requireUuid('offerId', i.offerId);
    const accountId = requireUuid('accountId', i.accountId);
    const out = await this.d.store.reject({ offerId, accountId, nowMs: this.d.clock.now() });
    if (out.kind === 'REJECTED') throw new TransferError(errorOfDecide(out.reason));
    return this.#view(out.offer, accountId);
  }

  async withdraw(i: { readonly offerId: string; readonly accountId: string; readonly idempotencyKey?: string }): Promise<TransferOfferView> {
    const offerId = requireUuid('offerId', i.offerId);
    const accountId = requireUuid('accountId', i.accountId);
    const out = await this.d.store.withdraw({ offerId, accountId, nowMs: this.d.clock.now() });
    if (out.kind === 'REJECTED') throw new TransferError(errorOfDecide(out.reason));
    return this.#view(out.offer, accountId);
  }

  /** 돌려주기. 재인증(FAN_SENSITIVE/TICKET_RETURN) → 행 잠금 안 판정 */
  async returnToPayer(i: {
    readonly ticketId: string;
    readonly accountId: string;
    readonly sessionId: string;
    readonly reauthToken?: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly ticketId: string; readonly status: 'RETURNED' }> {
    const ticketId = requireUuid('ticketId', i.ticketId);
    const accountId = requireUuid('accountId', i.accountId);
    const key = requireUuid('idempotencyKey', i.idempotencyKey);
    await this.#reauth(i.reauthToken, { accountId, sessionId: i.sessionId }, 'FAN_SENSITIVE', 'TICKET_RETURN');
    const out = await this.d.store.returnToPayer({ ticketId, accountId, nowMs: this.d.clock.now(), idempotencyKey: key });
    if (out.kind === 'REJECTED') throw new TransferError(errorOfReturn(out.reason));
    return { ticketId: out.ticketId, status: 'RETURNED' };
  }

  /** 만료 작업. 만료된 OFFERED를 EXPIRED로 바꾸고 표시를 되돌린다 */
  async expireOffers(nowMs?: number): Promise<number> {
    return this.d.store.expireOffers(nowMs ?? this.d.clock.now(), 100);
  }

  /** 그 표의 잠금 표시(화면용). 잠금·풀림·기한·입장 시작을 반영한다 */
  async lockState(ticketId: string, nowMs?: number): Promise<{ readonly locked: boolean }> {
    return { locked: await this.d.store.lockActive(requireUuid('ticketId', ticketId), nowMs ?? this.d.clock.now()) };
  }

  /** TransferLockService. 입력 검사 뒤 저장소가 표마다 가른다 */
  async setTransferLock(i: SetTransferLockInput): Promise<readonly TransferLockOutcome[]> {
    const caseId = requireUuid('caseId', i.caseId);
    const eventId = requireUuid('eventId', i.eventId);
    if (!Number.isSafeInteger(i.version) || i.version < 1) throw new TransferError('INVALID_INPUT');
    if (i.accountIds.length === 0) throw new TransferError('INVALID_INPUT');
    const accountIds = [...new Set(i.accountIds.map((a) => requireUuid('accountId', a)))];
    if (i.locked && (i.expiresAtMs === undefined || !Number.isFinite(i.expiresAtMs))) throw new TransferError('INVALID_INPUT');
    return this.d.store.setTransferLock({ ...i, caseId, eventId, accountIds });
  }

  async #reauth(token: string | undefined, who: { accountId: string; sessionId: string }, act: TransferAct, op: TransferOp): Promise<void> {
    let ok: boolean;
    try {
      ok = await this.d.reauth.verify(token, { ...who, act, op });
    } catch (e) {
      if (e instanceof ReauthUnavailable) throw new TransferError('REAUTH_UNAVAILABLE');
      throw e;
    }
    if (!ok) throw new TransferError('REAUTH_REQUIRED');
  }

  #view(offer: TransferOfferRecord, accountId: string): TransferOfferView {
    return {
      offerId: offer.offerId,
      ticketId: offer.ticketId,
      role: offer.fromAccountId === accountId ? 'SENDER' : 'RECIPIENT',
      status: offer.status,
      expiresAt: new Date(offer.expiresAtMs).toISOString(),
      // 화면이 회차를 알 수 있게 ticket의 eventId를 싣는다(저장소가 채운 offer에는 없으므로 빈 값일 수 있다)
      eventId: (offer as TransferOfferRecord & { eventId?: string }).eventId ?? '',
    };
  }
}

/** offer에 eventId를 실어 보내는 저장소가 있을 수 있어 타입을 넓힌다 */
export type TransferOfferWithEvent = TransferOfferRecord & { readonly eventId?: string };

function errorOfCreate(r: CreateOfferRejection): TransferErrorCode {
  switch (r) {
    case 'NOT_HOLDER':
      return 'NOT_FOUND';
    case 'REOFFER':
      return 'REOFFER';
    case 'ENTRY_STARTED':
      return 'ENTRY_STARTED';
    case 'TRANSFER_CLOSED':
      return 'TRANSFER_CLOSED';
    case 'TRANSFER_LOCKED':
      return 'TRANSFER_LOCKED';
    case 'TRANSFER_PENDING':
      return 'TRANSFER_PENDING';
    case 'ALREADY_ENDED':
      return 'ALREADY_ENDED';
  }
}

function errorOfDecide(r: 'NOT_FOUND' | 'NOT_RECIPIENT' | 'NOT_OFFERED' | 'EXPIRED' | 'ENTRY_STARTED' | 'NOT_SENDER'): TransferErrorCode {
  if (r === 'NOT_FOUND' || r === 'NOT_RECIPIENT' || r === 'NOT_SENDER') return 'NOT_FOUND';
  return r;
}

function errorOfReturn(r: ReturnRejection | 'NOT_FOUND'): TransferErrorCode {
  if (r === 'NOT_HOLDER' || r === 'NOT_FOUND') return 'NOT_FOUND';
  return r;
}
