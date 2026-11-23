// SCR-041 양도 받기 실제 흐름(계획 docs/review/plans/F-05-2.md §4 '웹 모듈'·§5 T9·T11·T12·T16).
// 요청 읽기·수락은 화면 스크립트의 같은 사이트 요청이다(R-T21 ③). [거절]은 뒤 몫 F-05-11이라 부르지 않는다.
import type { Scr041State } from '../../../shared/config/screens.booking.ts';

export type OfferResult<T> =
  | { kind: 'ok'; body: T }
  | { kind: 'problem'; status: number; type: string; retryAfterSec?: number }
  | { kind: 'network' };

export interface OfferBody {
  readonly offerId: string;
  readonly ticketId?: string;
  readonly role?: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly eventId?: string;
  readonly withdrawReason?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface Net {
  readonly origin: string;
  readonly fetch: FetchLike;
}

const problemTypeOf = async (r: Response): Promise<string> => {
  try {
    const b = (await r.json()) as { type?: unknown } | null;
    if (b && typeof b.type === 'string') return b.type.split('/').filter(Boolean).pop() ?? 'about:blank';
  } catch {
    // 본문이 JSON이 아니다
  }
  return `http-${r.status}`;
};

async function reader<T>(r: Response): Promise<OfferResult<T>> {
  if (r.status === 200) {
    try {
      return { kind: 'ok', body: (await r.json()) as T };
    } catch {
      return { kind: 'problem', status: r.status, type: 'bad-response' };
    }
  }
  return { kind: 'problem', status: r.status, type: await problemTypeOf(r) };
}

async function send<T>(net: Net, method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}): Promise<OfferResult<T>> {
  try {
    const r = await net.fetch(`${net.origin}${path}`, { method, credentials: 'include', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json', ...headers } });
    return await reader<T>(r);
  } catch {
    return { kind: 'network' };
  }
}

const future = (iso: string | undefined, nowMs: number): boolean => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > nowMs;

/**
 * 요청 → SCR-041 상태 이름(d5 §5.23). 철회는 withdrawReason으로 문장을 가른다:
 * EVENT_CANCELLED=공연 취소, EVENT_POSTPONED=일정 변경, 그 밖·모르는 값=보낸 분 철회.
 */
export function offerStateOf(o: OfferBody, nowMs: number): Scr041State {
  if (o.status === 'WITHDRAWN') {
    if (o.withdrawReason === 'EVENT_CANCELLED') return '공연 취소로 철회됨';
    if (o.withdrawReason === 'EVENT_POSTPONED') return '일정 변경으로 철회됨';
    return '철회됨';
  }
  if (o.status === 'EXPIRED') return '기한 만료';
  if (o.status === 'ACCEPTED' || o.status === 'REJECTED' || o.status === 'RECLAIMED') return '처리됨';
  if (o.status === 'OFFERED') return future(o.expiresAt, nowMs) ? '요청' : '기한 만료';
  // 모르는 상태는 처리됨으로 읽어 받기 버튼을 열지 않는다
  return '처리됨';
}

/** 수락 409·404 → 상태. 확인할 수 없음(5xx·끊김·처리 중)은 받기 자리를 지키는 '요청'이다 */
export function acceptFailureStateOf(p: { status: number; type: string }): Scr041State {
  const type = p.type.split('/').filter(Boolean).pop() ?? p.type;
  if (p.status === 404) return '권한 없음';
  if (p.status === 409 && type === 'transfer-expired') return '기한 만료';
  if (p.status === 409 && type === 'entry-started') return '입장 시작';
  if (p.status === 409 && (type === 'transfer-not-offered' || type === 'ticket-ended')) return '처리됨';
  return '요청';
}

export function loadOffer(i: { readonly offerId: string } & Net): Promise<OfferResult<OfferBody>> {
  return send(i, 'GET', `/v1/transfers/${encodeURIComponent(i.offerId)}`);
}

export function acceptOffer(i: { readonly offerId: string; readonly idempotencyKey: string } & Net): Promise<OfferResult<OfferBody>> {
  return send(i, 'POST', `/v1/transfers/${encodeURIComponent(i.offerId)}/acceptance`, { 'idempotency-key': i.idempotencyKey });
}
