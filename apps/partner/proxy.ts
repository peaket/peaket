// 파트너 콘솔 proxy(OPS-340, docs/frontend.md §5.14.1, ADR-0360 결정 7): 모든 화면 경로(정적 자산·/_next 제외)에 화면 보안 헤더를 단다.
// - 묶음 B CSP(요청마다 nonce, 'strict-dynamic', 파트너 변형 connect-src)를 응답과 요청 머리에 싣는다(Next.js가 요청 CSP의 nonce를 스크립트에 붙인다).
//   루트 레이아웃이 요청 머리 x-nonce로 같은 nonce를 읽어 좁은 기본 Trusted Types 정책 스크립트(public/trusted-types-default.js)에 붙인다
// - 화면 종류별 헤더 PAGE_HEADERS.partner(Referrer-Policy no-referrer·COOP same-origin·Permissions-Policy), Reporting-Endpoints, Cache-Control private, no-store
// - Trusted Types는 보고 모드다. 정책 이름 목록은 실제로 만드는 이름만 둔다: peaket(ds 서식 글 기본 정책), peaket-paste(붙여넣기 해석),
//   nextjs(Next.js 클라이언트), default(좁은 기본 정책). 막는 모드로 바꾸는 것은 30일 위반 없음 뒤다(§5.14.1 'Trusted Types')
// 개발 서버(next dev)는 소비자 웹 proxy와 같게 CSP를 보고 모드로 단다(개발 도구의 인라인 스크립트). 에디터 Worker는 같은 출처 파일이라 worker-src 'self'로 받는다.
import { NextResponse, type NextRequest } from 'next/server';
import { PAGE_HEADERS, REPORTING_ENDPOINTS, renderCsp } from '@peaket/config/headers/security-headers.mjs';
import { partnerCspOrigins } from '@/shared/config/origins';
import { NONCE_HEADER, PARTNER_TRUSTED_TYPES_REPORT_ONLY } from '@/shared/config/security';

function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b));
}

export function proxy(req: NextRequest) {
  const nonce = newNonce();
  const csp = renderCsp('B', { nonce, variants: ['partner'], ...(partnerCspOrigins ? { origins: partnerCspOrigins } : {}) });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete('content-security-policy-report-only');
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set(NONCE_HEADER, nonce);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  const tt = PARTNER_TRUSTED_TYPES_REPORT_ONLY;
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Content-Security-Policy', csp);
    res.headers.set('Content-Security-Policy-Report-Only', tt);
  } else res.headers.set('Content-Security-Policy-Report-Only', `${csp}, ${tt}`);
  res.headers.set('Reporting-Endpoints', REPORTING_ENDPOINTS);
  for (const [k, v] of Object.entries(PAGE_HEADERS.partner)) res.headers.set(k, v);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

// 정적 자산(/_next/static·/_next/image·확장자가 있는 공개 파일)과 보고 받는 곳(/_t/)은 빼고 모든 화면 경로
export const config = { matcher: ['/((?!_next/static|_next/image|_t/|.*\\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|txt|json|webmanifest|xml)$).*)'] };
