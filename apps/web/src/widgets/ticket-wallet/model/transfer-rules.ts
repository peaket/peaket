// SCR-013 마이 티켓의 돌려주기·받은 요청 카드 가운데 **화면이 첫 렌더에 쓰는 순수 규칙**만 모은다.
// 네트워크·IndexedDB를 쓰는 함수(loadReceivedOffers·returnTicket)는 transfer-actions에 두고 WalletLive가 늦게 가져온다.
// 이렇게 나눠야 월렛 첫 화면 JS에 돌려주기 코드 전체가 실리지 않는다(docs/frontend.md §5.8, CI 실행 45240606103).
import type { WalletTicketSnapshot } from '../../../entities/wallet/index.ts';

export type WalletActionResult<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'problem'; status: number; type: string }
  | { kind: 'network' };

/** d5 §5.13 돌려주기 확인 대화상자 문구(보드 그대로) */
export const RETURN_CONFIRM_TEXT = '돌려주면 이 휴대폰의 입장 키가 지워집니다';

export interface ReturnableTicket {
  readonly ticketId: string;
  readonly status?: string;
  readonly received?: boolean;
  readonly eventStartsAt?: string;
  readonly entryOpensAt?: string;
}

const ENDED = new Set(['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED']);

const atOf = (iso: string | undefined): number | undefined => (typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : undefined);

/** 받은 티켓만, 입장 시작 전(입장 시작 시각을 알면 그것, 없으면 회차 시작), 끝나지 않은 표 */
export function canReturn(t: ReturnableTicket, nowMs: number): boolean {
  if (t.received !== true) return false;
  if (t.status !== undefined && ENDED.has(t.status)) return false;
  const opensAt = atOf(t.entryOpensAt) ?? atOf(t.eventStartsAt);
  return opensAt === undefined ? true : nowMs < opensAt;
}

/** I-T54 ④: 카카오를 먼저, 없으면 네이버 */
export function reauthProviderFor(linked: readonly string[]): string | undefined {
  if (linked.includes('kakao')) return 'kakao';
  if (linked.includes('naver')) return 'naver';
  return undefined;
}

export function returnReauthTarget(ticketId: string): { readonly purpose: 'ticket-return'; readonly returnTo: string } {
  return { purpose: 'ticket-return', returnTo: `/my/tickets/${encodeURIComponent(ticketId)}` };
}

/** 돌려주기 실패 → d5 §5.13·§9.2 문구. 서버 title은 쓰지 않는다 */
export function returnFailureOf(r: WalletActionResult<unknown>): { readonly text: string } {
  if (r.kind === 'network') return { text: '연결을 확인한 뒤 다시 시도해 주세요' };
  if (r.kind === 'problem') {
    const type = r.type.split('/').filter(Boolean).pop() ?? r.type;
    if (r.status === 409 && type === 'entry-started') return { text: '입장이 시작되어 돌려줄 수 없습니다' };
    if (r.status === 403 && type === 'reauth-required') return { text: '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요' };
    if (r.status === 409 && type === 'entry-recorded') return { text: '입장 기록이 있어 돌려줄 수 없습니다' };
    if (r.status === 409 && type === 'ticket-ended') return { text: '이미 끝난 티켓이라 돌려줄 수 없습니다' };
    if (r.status === 409 && type === 'payer-holds') return { text: '이미 결제자가 보유한 티켓입니다' };
    if (r.status === 422 && type === 'idempotency-key-reused') return { text: '이미 다른 요청에 쓴 키입니다. 화면을 새로 열어 다시 시도해 주세요' };
  }
  return { text: '돌려주지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
}

export interface ReceivedOfferItem {
  readonly offerId: string;
  readonly ticketId?: string;
  readonly role?: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly eventId?: string;
  readonly withdrawReason?: string;
}

/** 받은 요청 카드(SCR-013 ⑬): 기한 전 OFFERED만 SCR-041로 잇는다 */
export function receivedOfferCardsOf(items: readonly ReceivedOfferItem[], nowMs: number): { offerId: string; eventId: string; expiresAt: string; href: string }[] {
  return items
    .filter((o) => o.status === 'OFFERED' && typeof o.expiresAt === 'string' && Number.isFinite(Date.parse(o.expiresAt)) && Date.parse(o.expiresAt) > nowMs)
    .map((o) => ({ offerId: o.offerId, eventId: o.eventId ?? '', expiresAt: o.expiresAt as string, href: `/my/transfers/${encodeURIComponent(o.offerId)}` }));
}

/** 월렛 화면이 받은 요청 카드를 그릴 때 쓰는 저장 스냅샷 조회(없으면 undefined) */
export function receivedSnapshotOf(snapshot: WalletTicketSnapshot | undefined): boolean {
  return snapshot?.received === true;
}
