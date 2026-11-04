// 소비자 웹 화면 묶음별 보안 헤더(docs/frontend.md §2.5·§5.14.1, ADR-0065 결정 4, BUILD_ORDER HOT-290).
// - 경로 표 ROUTES: app/(request)·app/(cached)의 화면(page)과 처리기(route)를 주소 틀로 적는다. 경로 묶음은 주소에 드러나지 않아
//   proxy.ts가 주소만 보고 묶음을 고르려면 이 표가 필요하다. page-headers.test.mjs가 app/ 폴더와 같은지 본다.
// - 요청마다 그리는 화면(B·E·F)은 요청마다 만든 nonce로 CSP를 만든다. 캐시 화면(A)은 응답 때 해시를 채울 정책 틀을 싣는다(cachedCsp, ADR-0193).
// - 값은 packages/config/headers/security-headers.mjs 한 곳에서 가져온다(정본 글 상자·헤더 표와 글자까지 같다).
import { PAGE_HEADERS, REPORTING_ENDPOINTS, renderCsp, type CspBundle, type CspVariant, type ProdOrigins } from '@peaket/config/headers/security-headers.mjs';
import { CSP_TEMPLATE_HEADER, HASH_SENTINEL } from '../../../server/csp-template.mjs';

/** proxy.ts가 nonce를 실어 레이아웃에 넘기는 요청 헤더 */
export const NONCE_HEADER = 'x-nonce';

type PageKind = 'web' | 'seats' | 'checkout' | 'return' | 'staff' | 'verify-return';

export interface RouteRule {
  /** 주소 틀(app 폴더 경로에서 경로 묶음을 뺀 것). [이름]은 조각 하나 */
  pattern: string;
  group: 'request' | 'cached';
  /** page: 화면(헤더를 붙인다) · route: 처리기(JSON·이동 응답, 화면 헤더 없음) */
  kind: 'page' | 'route';
  bundle?: Extract<CspBundle, 'A' | 'B' | 'E' | 'F'>;
  page?: PageKind;
  variants?: CspVariant[];
}

const req = (pattern: string, bundle: 'B' | 'E' | 'F' = 'B', page: PageKind = 'web', variants?: CspVariant[]): RouteRule => ({
  pattern,
  group: 'request',
  kind: 'page',
  bundle,
  page,
  ...(variants ? { variants } : {}),
});
const cached = (pattern: string, page: PageKind = 'web'): RouteRule => ({ pattern, group: 'cached', kind: 'page', bundle: 'A', page });
const handler = (pattern: string): RouteRule => ({ pattern, group: 'request', kind: 'route' });

/** app/ 폴더의 화면·처리기 전부(page-headers.test.mjs가 폴더와 대조한다) */
export const ROUTES: readonly RouteRule[] = [
  // (cached) 묶음 A: 홈·공연 상세·검색 셸·굿즈·정적 문서·복귀 화면·스태프 화면·셔플 검증·월렛 셸(§5.14.1)
  cached('/'),
  cached('/booking/[eventId]/checkout/return', 'return'),
  // 공연 상세는 사람 확인 위젯을 싣는다(§5.14.1 A의 '+' 줄)
  { ...cached('/events/[id]'), variants: ['humanCheck'] },
  cached('/events/[id]/shuffle-proof'),
  cached('/help'),
  cached('/my/tickets'),
  cached('/my/tickets/[ticketId]'),
  cached('/open-in-browser'),
  cached('/policy/[slug]'),
  cached('/preview'),
  cached('/search'),
  cached('/shop'),
  cached('/shop/[productId]'),
  cached('/staff/approve', 'staff'),
  cached('/staff/invitations', 'staff'),
  cached('/system-notice'),
  cached('/verify/return', 'verify-return'),
  // (request) 묶음 B·E·F: 추가 검증·결과·/my/*(월렛 셸 제외)·로그인, 결제(E), 좌석(F)
  req('/booking/[eventId]/checkout', 'E', 'checkout'),
  req('/booking/[eventId]/result'),
  req('/booking/[eventId]/seats', 'F', 'seats'),
  req('/help/inquiries'),
  req('/help/inquiries/[id]'),
  req('/help/inquiries/new'),
  req('/login'),
  req('/login/link'),
  req('/my/appeals/[id]'),
  req('/my/compensations/[id]'),
  req('/my/likes'),
  req('/my/orders'),
  req('/my/orders/[orderId]'),
  req('/my/refunds/[refundId]/account'),
  req('/my/settings'),
  req('/my/settings/providers'),
  req('/my/tickets/[ticketId]/addons'),
  req('/my/tickets/[ticketId]/cancel'),
  req('/my/tickets/[ticketId]/transfer'),
  req('/my/transfers/[offerId]'),
  // 추가 검증 자리(SCR-009)는 사람 확인 위젯을 싣는다. nonce 화면이라 위젯 스크립트에 nonce를 붙이고, frame-src에 위젯 출처가 든다(architecture §6.3)
  req('/queue/[eventId]/verify', 'B', 'web', ['humanCheck']),
  req('/shop/cart'),
  req('/shop/checkout', 'E', 'checkout'),
  req('/signup/consent'),
  req('/staff', 'B', 'staff'),
  handler('/link/[provider]'),
  handler('/login/[provider]'),
  handler('/login/callback/[provider]'),
  handler('/logout'),
  handler('/reauth/[provider]'),
  handler('/reauth/token'),
  handler('/v1/identity/link-proposals/[proposalId]'),
  handler('/v1/identity/link-proposals/[proposalId]/separate-account'),
];

const compiled = ROUTES.map((r) => ({
  rule: r,
  // 고정 조각이 많은 틀이 먼저 맞게 한다(/login/link가 /login/[provider]보다 먼저)
  fixed: r.pattern.split('/').filter((s) => s && !s.startsWith('[')).length,
  re: new RegExp(`^${r.pattern === '/' ? '/' : r.pattern.replace(/\[[^\]]+\]/g, '[^/]+').replace(/\//g, '\\/')}$`),
})).sort((a, b) => b.fixed - a.fixed);

/** 주소(경로만, 끝 / 없이)에 맞는 규칙. 없으면 undefined */
export function matchRoute(pathname: string): RouteRule | undefined {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return compiled.find((c) => c.re.test(p))?.rule;
}

/** 요청마다 새로 만드는 nonce: 128비트 난수의 base64(CSP3 권고) */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function otherHeaders(page: PageKind): Record<string, string> {
  switch (page) {
    case 'seats':
      return { ...PAGE_HEADERS.seats };
    case 'checkout':
      return { ...PAGE_HEADERS.checkout };
    // 복귀·스태프 화면은 Referrer-Policy no-referrer(§5.14.1 헤더 표)
    case 'return':
    case 'staff':
      return { ...PAGE_HEADERS.web, 'Referrer-Policy': 'no-referrer' };
    // 본인확인 복귀 화면은 기관 화면에서 넘어올 때 창 관계가 끊기지 않게 COOP unsafe-none(docs/features/identity.md §5)
    case 'verify-return':
      return { ...PAGE_HEADERS.web, 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'unsafe-none' };
    default:
      return { ...PAGE_HEADERS.web };
  }
}

export interface PageHeaderOptions {
  /** 요청 화면(B·E·F)의 nonce. 없으면 요청 화면 헤더를 만들지 않고 던진다 */
  nonce?: string;
  /** 환경마다 다른 출처(로컬 개발 등) */
  origins?: Partial<ProdOrigins>;
}

/** 경로 표에 없는 주소(없는 화면의 404 등)는 캐시 화면처럼 다룬다: 빠진 화면이 헤더·CSP 없이 나가지 않게 한다 */
const FALLBACK: RouteRule = { pattern: '*', group: 'cached', kind: 'page', bundle: 'A', page: 'web' };

/**
 * 그 주소 화면의 보안 헤더. 처리기는 null, 표에 없는 주소는 캐시 화면 헤더.
 * 캐시 화면(A)의 CSP는 cachedCsp가 정한다(SRI PoC 결과, HOT-290). 여기서는 CSP 밖 헤더만 준다.
 */
export function pageHeaders(pathname: string, o: PageHeaderOptions = {}): Record<string, string> | null {
  const r = matchRoute(pathname) ?? FALLBACK;
  if (r.kind !== 'page') return null;
  const page = otherHeaders(r.page ?? 'web');
  if (r.group === 'cached') return page;
  if (!o.nonce) throw new TypeError(`요청 화면 ${r.pattern}에는 요청마다 만든 nonce가 필요하다`);
  return {
    'Content-Security-Policy': renderCsp(r.bundle!, { nonce: o.nonce, origins: o.origins, variants: r.variants }),
    'Reporting-Endpoints': REPORTING_ENDPOINTS,
    ...page,
  };
}

/**
 * 캐시 화면(A)의 CSP. Next.js 해시 방식(SRI)은 App Router 인라인 스크립트를 덮지 못해(SRI PoC, HOT-290), 소유자 결정(2026-11-04,
 * ADR-0193)대로 응답 때 해시를 채운다: 해시 자리(HASH_SENTINEL)를 넣은 막는 정책 틀을 안쪽 머리(CSP_TEMPLATE_HEADER)로 싣고,
 * 앞 서버(server/csp-hash-server.mjs)가 HTML을 다 받은 뒤 인라인 스크립트 해시로 채워 Content-Security-Policy로 단다.
 * 앞 서버 없이 뜬 때(next dev·next start 직접)를 위해 해시 없는 보고 모드 정책도 싣는다(앞 서버는 이것을 지운다).
 * 요청 화면·처리기는 빈 객체, 표에 없는 주소는 캐시 화면 정책.
 */
export function cachedCsp(pathname: string, o: Pick<PageHeaderOptions, 'origins'> = {}): Record<string, string> {
  const r = matchRoute(pathname) ?? FALLBACK;
  if (r.kind !== 'page' || r.group !== 'cached') return {};
  return {
    [CSP_TEMPLATE_HEADER]: renderCsp('A', { origins: o.origins, variants: r.variants, hashes: [HASH_SENTINEL] }),
    'Content-Security-Policy-Report-Only': renderCsp('A', { origins: o.origins, variants: r.variants }),
    'Reporting-Endpoints': REPORTING_ENDPOINTS,
  };
}
