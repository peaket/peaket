// SCR-038 예매 취소의 실제 흐름 값: 재인증 purpose·결과·오류·재인증 왕복 표시·멱등키 규칙(docs/frontend.md §4.1·§4.2.4, d5 §5.20).
// 순수 함수만 둔다. API 실행부·브라우저 저장소는 부르는 쪽(TicketCancelLive)이 넘긴다.
// 계좌는 어디에도 저장하지 않는다: 이 파일의 PendingCancel에도 계좌 칸이 없다(payment §6, POL-014).

// 재인증 확인기 503 문구는 공용 파일 한 곳만 쓴다(RV-09, docs/frontend.md §4.3)
import { REAUTH_UNAVAILABLE } from '../../../shared/lib/reauth-failure.ts';

/** 재인증 웹 purpose. 앱 서버 REAUTH_PURPOSE_OPS의 두 값과 짝이다(authz-matrix §6, ADR-0293) */
export type CancelPurpose = 'ticket-cancel' | 'ticket-cancel-refund-account';

/** 취소 견적에서 purpose를 정하는 데 필요한 값만 본다(구조적 타입이라 QuoteView를 그대로 넘길 수 있다) */
export interface QuotePurposeInput {
  readonly refundAccountRequired?: unknown;
}

/**
 * 견적의 `refundAccountRequired`가 참이면 계좌를 함께 보내는 취소라 `ticket-cancel-refund-account`,
 * 아니면 `ticket-cancel`이다. 값이 없거나 모르면 계좌 없는 쪽으로 두고, 서버가 422로 알려 주면 그때 계좌를 받는다.
 */
export function reauthPurposeOf(q: QuotePurposeInput | null | undefined): CancelPurpose {
  return q?.refundAccountRequired === true ? 'ticket-cancel-refund-account' : 'ticket-cancel';
}

/** 202 응답의 결과 카드 종류(d5 §5.20 ⑥) */
export type CancelResultKind = 'refunded' | 'deferred' | 'pending-account' | 'pending';

/** 202 `status` 세 값과 `refundAccountRequired`로 결과 카드를 가른다. 모르는 상태는 `pending`이다 */
export function resultViewOf(c: { readonly status?: unknown; readonly refundAccountRequired?: unknown } | null | undefined): CancelResultKind {
  if (c?.status === 'REFUNDED') return 'refunded';
  if (c?.status === 'REQUESTED') return 'deferred';
  if (c?.status === 'REFUND_PENDING') return c.refundAccountRequired === true ? 'pending-account' : 'pending';
  return 'pending';
}

/** 화면이 가르는 오류 종류. 서버 title·detail은 쓰지 않고 정본 문구만 고른다(d5 §9.2, frontend §4.1 '오류 모양') */
export type CancelErrorKind =
  | 'reauth'
  | 'reauth-unavailable'
  | 'account-required'
  | 'account-invalid'
  | 'transfer'
  | 'entry-started'
  | 'event-cancelled'
  | 'conflict'
  | 'not-payer'
  | 'not-found'
  | 'dependency'
  | 'other';

export interface CancelError {
  kind: CancelErrorKind;
  text: string;
}

export interface ProblemLike {
  readonly status?: unknown;
  readonly type?: unknown;
}

const REAUTH_REQUIRED_TEXT = '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요';
const ACCOUNT_REQUIRED_TEXT = '환불받을 계좌를 입력해 주세요. 계좌를 넣으면 다시 시도할 수 있습니다';
const ACCOUNT_INVALID_TEXT = '은행과 계좌번호, 예금주를 다시 확인해 주세요';
const DEPENDENCY_TEXT = '환급액을 계산하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
const TRANSFER_TEXT = '양도 요청을 철회한 뒤 취소할 수 있습니다';
const ENTRY_STARTED_TEXT = '공연이 시작되어 취소할 수 없습니다';
const EVENT_CANCELLED_TEXT = '회차 취소가 확정되어 공제 없이 일괄 환불합니다. 예매 내역에서 진행 상태를 확인해 주세요';
const CONFLICT_TEXT = '이미 처리 중입니다. 예매 내역에서 확인해 주세요';
const NOT_PAYER_TEXT = '결제한 분만 취소할 수 있습니다';
const NOT_FOUND_TEXT = '찾을 수 없습니다';
const OTHER_TEXT = '취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요';

/** 문제 type의 끝 이름(ApiError.type은 이미 끝 이름이지만, 주소 전체를 넘겨도 맞춘다) */
function typeOf(v: unknown): string {
  return typeof v === 'string' ? (v.split('/').pop() ?? '') : '';
}

/**
 * ApiError(또는 같은 모양)를 화면 문구로 바꾼다. 차례: 403 reauth-required → 403 not-payer → 503
 * reauth-unavailable → 503 dependency-unavailable → 422/400 계좌 → 409 넷 → 404 → 그 밖.
 */
export function errorOf(e: ProblemLike | null | undefined): CancelError {
  const status = typeof e?.status === 'number' ? e.status : 0;
  const type = typeOf(e?.type);
  if (status === 403 && type === 'reauth-required') return { kind: 'reauth', text: REAUTH_REQUIRED_TEXT };
  if (status === 403 && type === 'not-payer') return { kind: 'not-payer', text: NOT_PAYER_TEXT };
  if (status === 503 && type === 'reauth-unavailable') return { kind: 'reauth-unavailable', text: REAUTH_UNAVAILABLE };
  if (status === 503 && type === 'dependency-unavailable') return { kind: 'dependency', text: DEPENDENCY_TEXT };
  if (status === 422 && type === 'refund-account-required') return { kind: 'account-required', text: ACCOUNT_REQUIRED_TEXT };
  if (status === 400 && type === 'invalid-body') return { kind: 'account-invalid', text: ACCOUNT_INVALID_TEXT };
  if (status === 409 && type === 'transfer-pending') return { kind: 'transfer', text: TRANSFER_TEXT };
  if (status === 409 && type === 'entry-started') return { kind: 'entry-started', text: ENTRY_STARTED_TEXT };
  if (status === 409 && type === 'event-cancelled') return { kind: 'event-cancelled', text: EVENT_CANCELLED_TEXT };
  if (status === 409) return { kind: 'conflict', text: CONFLICT_TEXT };
  if (status === 404) return { kind: 'not-found', text: NOT_FOUND_TEXT };
  return { kind: 'other', text: OTHER_TEXT };
}

/** 재인증 왕복 표시(sessionStorage). 계좌 칸은 없다(재인증 왕복 동안 계좌를 저장하지 않는다) */
export interface PendingCancel {
  ticketId: string;
  key: string;
}

export const PENDING_KEY = 'peaket.ticket-cancel.pending';

/** sessionStorage와 같은 최소 모양(시험은 가짜 저장소를 넘긴다) */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 재인증으로 떠나기 전에 남긴다. 같은 티켓의 표시가 있으면 덮어쓴다(한 번에 한 취소다) */
export function writePending(session: StorageLike, p: PendingCancel): void {
  try {
    session.setItem(PENDING_KEY, JSON.stringify({ ticketId: p.ticketId, key: p.key }));
  } catch {
    // 저장소를 못 쓰면 돌아온 뒤 이어 가지 못하고 다시 인증해야 한다(계좌·토큰은 원래 저장하지 않는다)
  }
}

/** 돌아왔을 때 표시를 한 번만 꺼낸다. 없거나 모양이 틀리면 null이고 늘 지운다 */
export function takePending(session: StorageLike): PendingCancel | null {
  let raw: string | null = null;
  try {
    raw = session.getItem(PENDING_KEY);
    session.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { ticketId?: unknown; key?: unknown };
    return typeof v.ticketId === 'string' && v.ticketId && typeof v.key === 'string' && v.key ? { ticketId: v.ticketId, key: v.key } : null;
  } catch {
    return null;
  }
}

/** 같은 본문이면 같은 키, 본문이 바뀌면 새 키(frontend §4.1 '멱등키', guidelines §4) */
export interface AttemptKey {
  body: string;
  key: string;
}

/**
 * 보낼 본문의 지문이 앞 시도와 같으면 그 키를 그대로 쓴다. 다르면(예: 422 뒤 계좌를 더함) 새 키다.
 * 같은 키에 다른 본문을 보내면 서버가 422 idempotency-key-reused로 막는다.
 */
export function keyForBody(previous: AttemptKey | null, body: unknown, makeKey: () => string): AttemptKey {
  const text = JSON.stringify(body ?? {});
  return previous && previous.body === text ? previous : { body: text, key: makeKey() };
}
