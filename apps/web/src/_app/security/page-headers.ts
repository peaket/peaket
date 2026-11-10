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
const cached = (pattern: string, page: PageKind = 'web', variants?: CspVariant[]): RouteRule => ({ pattern, group: 'cached', kind: 'page', bundle: 'A', page, ...(variants ? { variants } : {}) });
const handler = (pattern: string): RouteRule => ({ pattern, group: 'request', kind: 'route' });

/** app/ 폴더의 화면·처리기 전부(page-headers.test.mjs가 폴더와 대조한다) */
export const ROUTES: readonly RouteRule[] = [
  // (cached) 묶음 A: 홈·공연 상세·검색 셸·굿즈·정적 문서·복귀 화면·스태프 화면·셔플 검증·월렛 셸(§5.14.1)
  cached('/'),
  cached('/booking/[eventId]/checkout/return', 'return'),
  // 공연 상세는 사람 확인 위젯을 싣고 본인확인기관 창을 연다(§5.14.1 A의 '+' 줄 둘, '변형은 실제 화면에 걸려야 한다')
  cached('/events/[id]', 'web', ['humanCheck', 'identityForm']),
  cached('/events/[id]/shuffle-proof'),
  cached('/help'),
  // 월렛은 부스 재발급의 대조 본인확인(목적 booth)을 연다(§5.14.1 A의 '+' 줄)
  cached('/my/tickets', 'web', ['identityForm']),
  cached('/my/tickets/[ticketId]', 'web', ['identityForm']),
  cached('/open-in-browser'),
  cached('/policy/[slug]'),
  cached('/preview'),
  cached('/search'),
  cached('/shop'),
  cached('/shop/[productId]'),
  cached('/staff/approve', 'staff'),
  // 스태프 초대 수락은 본인확인을 연다(§5.14.1 A의 '+' 줄)
  cached('/staff/invitations', 'staff', ['identityForm']),
  cached('/system-notice'),
  cached('/verify/return', 'verify-return'),
  // (request) 묶음 B·E·F: 추가 검증·결과·/my/*(월렛 셸 제외)·로그인, 결제(E), 좌석(F)
  // 주문·결제의 '본인확인 정보 없음'은 [휴대폰 본인확인]으로 기관 창을 연다
  req('/booking/[eventId]/checkout', 'E', 'checkout', ['identityForm']),
  req('/booking/[eventId]/result'),
  req('/booking/[eventId]/seats', 'F', 'seats'),
  req('/help/inquiries'),
  req('/help/inquiries/[id]'),
  req('/help/inquiries/new'),
  // 로그인 시작(POST /login/{p})·로그인 수단 잇기 확인은 303으로 제공자로 간다: form-action에 제공자 인가 출처(ADR-0215)
  req('/login', 'B', 'web', ['socialLogin']),
  req('/login/link', 'B', 'web', ['socialLogin']),
  req('/my/appeals/[id]'),
  req('/my/compensations/[id]'),
  req('/my/likes'),
  req('/my/orders'),
  req('/my/orders/[orderId]'),
  req('/my/refunds/[refundId]/account'),
  // 탈퇴·원격 로그아웃의 재인증(POST /reauth/{p})과 로그인 수단 해제·추가(POST /reauth·/link/{p})도 제공자로 간다(ADR-0215)
  // 계정 설정은 [휴대폰 본인확인]도 둔다
  req('/my/settings', 'B', 'web', ['socialLogin', 'identityForm']),
  req('/my/settings/providers', 'B', 'web', ['socialLogin']),
  req('/my/tickets/[ticketId]/addons'),
  req('/my/tickets/[ticketId]/cancel'),
  req('/my/tickets/[ticketId]/transfer'),
  req('/my/transfers/[offerId]'),
  // 추가 검증 자리(SCR-009)는 사람 확인 위젯을 싣는다. nonce 화면이라 위젯 스크립트에 nonce를 붙이고, frame-src에 위젯 출처가 든다(architecture §6.3).
  // ③ 본인확인 다시 하기가 기관 창 양식을 제출하므로 form-action에 본인확인기관 출처가 든다(§5.14.1 B의 '+' 줄, ADR-0259 결정 12)
  req('/queue/[eventId]/verify', 'B', 'web', ['humanCheck', 'identityForm']),
  req('/shop/cart'),
  req('/shop/checkout', 'E', 'checkout'),
  // 가입 완료(SCR-005)는 [지금 본인확인]으로 기관 창을 연다
  req('/signup/consent', 'B', 'web', ['identityForm']),
  req('/staff', 'B', 'staff'),
  handler('/link/[provider]'),
  handler('/login/[provider]'),
  handler('/login/callback/[provider]'),
  handler('/logout'),
  handler('/reauth/[provider]'),
  handler('/reauth/token'),
  handler('/demo/pg-simulator/authenticate'),
  handler('/v1/identity/link-proposals/[proposalId]'),
  handler('/v1/identity/link-proposals/[proposalId]/separate-account'),
];

/**
 * 본인확인기관 출처의 자리 값(docs/frontend.md §5.14.1 '변형은 실제 화면에 걸려야 한다'): 운영 출처는 연동 계약 때 정해 아직 없다.
 * 예약 이름(.example, RFC 2606)이라 누구의 출처도 아니어서 막는 정책에 실려도 어디로도 양식을 보내게 열지 않는다.
 * 로컬·CI는 identityAgencyOrigins(모의 기관 주소)나 PEAKET_CSP_ORIGINS의 identity로 바꾼다. 계약 뒤에는 그 출처를 넘긴다
 */
export const IDENTITY_AGENCY_PLACEHOLDER = 'https://identity-agency.example';

/** 모의 본인확인기관을 쓰는 환경(identity-svc 시험 어댑터 test-verification-provider.ts의 ALLOWED_ENVS와 같다) */
const MOCK_AGENCY_ENVS: readonly string[] = ['local', 'ci', 'demo'];

type Env = Readonly<Record<string, string | undefined>>;
/** 설정 경고 한 줄(정규 로그 꼴). 시험은 대역을 넘긴다 */
export type OriginWarn = (message: string) => void;
const warnLine: OriginWarn = (message) => console.warn(JSON.stringify({ level: 'warn', kind: 'csp-origins', msg: message }));

/**
 * 본인확인기관 출처의 꼴을 본다: https(모의 기관 환경에서는 http의 localhost·127.0.0.1도), 호스트는 글자·숫자·점·붙임표만(와일드카드 없음),
 * 자격 증명 없음. exact면 값이 출처 그 자체여야 한다(경로·쿼리 없음, PEAKET_CSP_ORIGINS). 아니면 주소의 출처를 쓴다(창 주소 PEAKET_TEST_VERIFICATION_URL).
 * 맞으면 출처, 틀리면 까닭. renderCsp의 출처 검사보다 좁아서, 여기를 지난 값으로는 헤더 만들기가 던지지 않는다
 */
function agencyOrigin(raw: unknown, env: string | undefined, exact: boolean): { ok: string } | { bad: string } {
  if (typeof raw !== 'string' || raw === '') return { bad: '글자가 아니다' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { bad: '주소가 아니다' };
  }
  if (u.username !== '' || u.password !== '') return { bad: '자격 증명이 들었다' };
  if (!/^[a-z0-9.-]+$/.test(u.hostname)) return { bad: '호스트 꼴이 틀렸다(와일드카드 등)' };
  if (exact && raw !== u.origin) return { bad: '출처(스킴·호스트·포트)만 적어야 한다' };
  if (u.protocol === 'https:') return { ok: u.origin };
  if (u.protocol === 'http:' && MOCK_AGENCY_ENVS.includes(env ?? '') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return { ok: u.origin };
  return { bad: u.protocol === 'http:' ? 'http는 모의 기관 환경(local·ci·demo)의 localhost·127.0.0.1만 받는다' : '스킴이 https가 아니다' };
}

/**
 * 모의 기관 환경(local·ci·demo)에서 본인확인기관 창을 모의 기관(services/identity-svc/scripts/mock-idv.mjs)으로 열면 그 출처를 본인확인을 여는 화면의
 * form-action에 넣는다. 주소는 identity-svc 시험 어댑터·가짜 API와 같은 PEAKET_TEST_VERIFICATION_URL(docs/features/identity.md §5 '기관 창 값')이다.
 * 그 밖의 환경이거나 값이 없으면 넣지 않는다. 꼴이 틀리면 넣지 않고 경고한다(헤더 만들기를 던지게 두면 웹 전체가 500이 된다)
 */
export function identityAgencyOrigins(env: Env, warn: OriginWarn = warnLine): Record<string, string> {
  if (!MOCK_AGENCY_ENVS.includes(env.PEAKET_ENV ?? '')) return {};
  const raw = env.PEAKET_TEST_VERIFICATION_URL;
  if (!raw) return {};
  const r = agencyOrigin(raw, env.PEAKET_ENV, false);
  if ('ok' in r) return { identity: r.ok };
  warn(`PEAKET_TEST_VERIFICATION_URL을 본인확인기관 출처로 쓰지 않는다: ${r.bad}`);
  return {};
}

/**
 * 환경마다 다른 CSP 출처(proxy.ts가 시작 때 한 번 만든다). 없으면 undefined(운영 출처, security-headers.mjs PROD_ORIGINS).
 * 로컬·CI에서 바꾼 제공자 issuer는 로그인·재인증 화면의 form-action 출처로 쓰고(ADR-0215), 모의 기관 환경의 모의 기관 주소는 본인확인을 여는 화면의
 * form-action 출처로 쓴다(없으면 자리 값). PEAKET_CSP_ORIGINS(JSON 객체)가 그보다 앞선다. 그 안의 identity는 꼴을 보고, 틀리면 그 출처만 빼고 경고한다
 */
export function cspOriginsFromEnv(env: Env, warn: OriginWarn = warnLine): Record<string, string> | undefined {
  const out: Record<string, string> = { ...socialAuthOrigins(env), ...identityAgencyOrigins(env, warn) };
  const raw = env.PEAKET_CSP_ORIGINS;
  if (raw) {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TypeError('PEAKET_CSP_ORIGINS는 JSON 객체여야 한다');
    const { identity, ...rest } = o as Record<string, unknown>;
    Object.assign(out, rest as Record<string, string>);
    if (identity !== undefined) {
      const r = agencyOrigin(identity, env.PEAKET_ENV, true);
      if ('ok' in r) out.identity = r.ok;
      else warn(`PEAKET_CSP_ORIGINS의 identity를 쓰지 않는다: ${r.bad}`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 출처 표에 본인확인기관 자리 값을 채운다(넘긴 값이 앞선다). identityForm 변형이 없는 화면에는 쓰이지 않는다 */
const withIdentity = (origins: Partial<ProdOrigins> | undefined): Partial<ProdOrigins> & { identity: string } => ({ identity: IDENTITY_AGENCY_PLACEHOLDER, ...origins });

/**
 * 로컬·CI에서 제공자 issuer를 모의 제공자로 바꾸면(PEAKET_OIDC_{P}_ISSUER, social-login config가 local·ci에서만 받는다) 그 출처를
 * 로그인·재인증 화면의 form-action에 넣을 출처로 돌려준다(ADR-0215). 없거나 꼴이 틀리면 넣지 않는다(운영 출처 그대로)
 */
export function socialAuthOrigins(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  const originOf = (v: string | undefined): string | undefined => {
    if (!v) return undefined;
    try {
      return new URL(v).origin;
    } catch {
      return undefined;
    }
  };
  const kakao = originOf(env.PEAKET_OIDC_KAKAO_ISSUER);
  if (kakao) {
    out.kakaoAuth = kakao;
    out.kakaoAccounts = kakao;
  }
  const naver = originOf(env.PEAKET_OIDC_NAVER_ISSUER);
  if (naver) out.naverAuth = naver;
  const google = originOf(env.PEAKET_OIDC_GOOGLE_ISSUER);
  if (google) out.googleAuth = google;
  return out;
}

/** 정규식 글자로 해석되는 문자를 모두 이스케이프한다(경로 틀은 정적이지만, 틀에 든 .·+ 같은 글자가 뜻을 바꾸지 않게) */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 경로 틀의 동적 조각([id])만 [^/]+로 바꾸고 나머지 조각은 글자 그대로 본다 */
const routeRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('/').map((seg) => (/^\[[^\]]+\]$/.test(seg) ? '[^/]+' : escapeRegExp(seg))).join('\\/')}$`);

const compiled = ROUTES.map((r) => ({
  rule: r,
  // 고정 조각이 많은 틀이 먼저 맞게 한다(/login/link가 /login/[provider]보다 먼저)
  fixed: r.pattern.split('/').filter((s) => s && !s.startsWith('[')).length,
  re: routeRegExp(r.pattern),
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
  /** 환경마다 다른 출처(로컬 개발 등). 본인확인기관 출처는 identity(없으면 IDENTITY_AGENCY_PLACEHOLDER) */
  origins?: Partial<ProdOrigins> & { identity?: string };
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
    'Content-Security-Policy': renderCsp(r.bundle!, { nonce: o.nonce, origins: withIdentity(o.origins), variants: r.variants }),
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
    [CSP_TEMPLATE_HEADER]: renderCsp('A', { origins: withIdentity(o.origins), variants: r.variants, hashes: [HASH_SENTINEL] }),
    'Content-Security-Policy-Report-Only': renderCsp('A', { origins: withIdentity(o.origins), variants: r.variants }),
    'Reporting-Endpoints': REPORTING_ENDPOINTS,
  };
}
