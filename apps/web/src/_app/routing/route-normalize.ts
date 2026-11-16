// 캐시 화면 경로의 정규 주소 표(W7L2-S10, docs/frontend.md §5.18 '공유 캐시 처리기 세부' '정규 주소 하나로 모은다', BAT-170 계획 §16).
// proxy.ts(요청 가로채기)와 일곱 화면이 함께 쓴다. 같은 자료를 가리키는 여러 글자(UUID 대소문자 변형 등)가 저마다 200이 되어
// 공유 캐시 키를 만들지 않게, 캐시 화면의 경로 조각은 정본 꼴 하나만 받는다.
// - UUID 칸은 소문자만 정본이다. 대소문자만 다르면 소문자 주소로 308(쿼리 그대로).
// - 로케일 칸은 en·ja·zh 소문자만. 대소문자만 다르면 308, 그 밖(ko 포함)은 404.
// - 닫힌 목록 칸(정책 문서 이름, 데모·시험 고정 자료 ID)은 목록의 글자 그대로만 받는다. 그 밖은 404.
// - 퍼센트 부호로 감싼 글자는 풀어서 정본 꼴이면 308, 풀어도 꼴 밖이면 404.
// 새 캐시 화면 경로는 이 표에 먼저 적는다(정본 같은 자리).

export type RouteDecision = { kind: 'ok' } | { kind: 'redirect'; location: string } | { kind: 'not-found' };

import { PERFORMANCES } from '../../entities/performance/model.ts';
import { POLICY_DOCS } from '../../entities/policy-doc/model.ts';
import { PRODUCTS } from '../../entities/product/model.ts';
import { TICKETS } from '../../entities/ticket/model.ts';
import { WALLET_TICKET_IDS } from '../../widgets/ticket-wallet/model/wallet.ts';

/** 칸 종류: 공연 상세의 회차 ID(UUID만), 회차·티켓·상품 ID(UUID 또는 고정 자료), 로케일, 정책 문서 이름 */
export type SegmentKind = 'event-detail' | 'event' | 'ticket' | 'product' | 'locale' | 'policy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_UUID_ANY_CASE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 데모·시험 고정 자료 ID의 닫힌 목록: 그 화면이 지금 받는 고정 자료의 ID 그대로다(목록을 여기 다시 적지 않고 자료 모듈에서 읽는다,
 * docs/frontend.md §5.18 '정규 주소 하나로 모은다', 계획 §16). 회차 고정 자료는 shuffle-proof·checkout/return에, 월렛·티켓 고정 자료는
 * /my/tickets/{ticketId}에, 상품 고정 자료는 /shop/{productId}에 쓴다. 공연 상세·로케일 상세는 UUID만 받는다(event-detail)
 */
const FIXTURES: Record<'event' | 'ticket' | 'product', ReadonlySet<string>> = {
  event: new Set(PERFORMANCES.map((p) => p.id)),
  ticket: new Set([...WALLET_TICKET_IDS, ...TICKETS.map((t) => t.id)]),
  product: new Set(PRODUCTS.map((p) => p.id)),
};
/** 로케일 접두(정본: 소문자, 한국어는 접두 없음) */
const LOCALES: ReadonlySet<string> = new Set(['en', 'ja', 'zh']);
/** 정책 문서 이름(src/entities/policy-doc의 문서 목록) */
const POLICY_SLUGS: ReadonlySet<string> = new Set(POLICY_DOCS.map((d) => d.slug));

/** 캐시 화면에서 경로 조각을 받는 경로 일곱. 앞의 것이 먼저다 */
const ROUTES: readonly { re: RegExp; kinds: readonly SegmentKind[]; build: (s: readonly string[]) => string }[] = [
  { re: /^\/events\/([^/]*)\/shuffle-proof$/, kinds: ['event'], build: ([id]) => `/events/${id}/shuffle-proof` },
  { re: /^\/events\/([^/]*)$/, kinds: ['event-detail'], build: ([id]) => `/events/${id}` },
  { re: /^\/([^/]*)\/events\/([^/]*)$/, kinds: ['locale', 'event-detail'], build: ([l, id]) => `/${l}/events/${id}` },
  { re: /^\/my\/tickets\/([^/]*)$/, kinds: ['ticket'], build: ([id]) => `/my/tickets/${id}` },
  // `/shop/cart`·`/shop/checkout`은 따로 있는 화면이라 상품 칸이 아니다
  { re: /^\/shop\/(?!cart$|checkout$)([^/]*)$/, kinds: ['product'], build: ([id]) => `/shop/${id}` },
  { re: /^\/policy\/([^/]*)$/, kinds: ['policy'], build: ([slug]) => `/policy/${slug}` },
  { re: /^\/booking\/([^/]*)\/checkout\/return$/, kinds: ['event'], build: ([id]) => `/booking/${id}/checkout/return` },
];

/** 퍼센트 부호를 푼다. 풀 수 없으면 null */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 칸 하나의 정본 글자(풀고 정규화한 값). 꼴 밖이면 null */
export function canonicalSegment(kind: SegmentKind, raw: string): string | null {
  const value = decodeSegment(raw);
  if (value === null || value === '') return null;
  if (kind === 'locale') {
    const lower = value.toLowerCase();
    return LOCALES.has(lower) ? lower : null;
  }
  if (kind === 'policy') return POLICY_SLUGS.has(value) ? value : null;
  if (kind !== 'event-detail' && FIXTURES[kind].has(value)) return value;
  return HEX_UUID_ANY_CASE.test(value) ? value.toLowerCase() : null;
}

/** 화면의 겹친 가드: 받은 조각(Next.js가 푼 값)이 정본 꼴과 글자까지 같은가. 다르면 화면은 캐시 함수를 부르지 않고 404다 */
export function isCanonicalSegment(kind: SegmentKind, value: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  if (kind === 'locale') return LOCALES.has(value);
  if (kind === 'policy') return POLICY_SLUGS.has(value);
  if (kind === 'event-detail') return UUID.test(value);
  return FIXTURES[kind].has(value) || UUID.test(value);
}

/** 경로(와 쿼리)를 정본 꼴과 견준다: 그대로면 ok, 대소문자·퍼센트 감싸기만 다르면 정본 주소로 308(쿼리 보존), 꼴 밖이면 404. 표 밖의 경로는 ok */
export function normalizeRoute(pathname: string, search = ''): RouteDecision {
  for (const route of ROUTES) {
    const m = route.re.exec(pathname);
    if (!m) continue;
    const segments: string[] = [];
    for (const [i, kind] of route.kinds.entries()) {
      const canonical = canonicalSegment(kind, m[i + 1] ?? '');
      if (canonical === null) return { kind: 'not-found' };
      segments.push(canonical);
    }
    const location = route.build(segments);
    if (location === pathname) return { kind: 'ok' };
    const query = search === '' || search === '?' ? '' : search.startsWith('?') ? search : `?${search}`;
    return { kind: 'redirect', location: `${location}${query}` };
  }
  return { kind: 'ok' };
}
