// 소비자 웹의 요청 가로채기(Next.js 16 proxy, 화면을 그리기 전에 요청을 먼저 본다).
// ① 화면 묶음별 보안 헤더(docs/frontend.md §2.5·§5.14.1, ADR-0065 결정 4, BUILD_ORDER HOT-290):
//    요청마다 그리는 화면(B·E·F)은 요청마다 nonce를 만들어 요청 헤더 Content-Security-Policy·x-nonce에 싣는다.
//    Next.js가 요청 CSP에서 nonce를 읽어 프레임워크 스크립트에 붙이고, 루트 레이아웃이 x-nonce를 읽는다. 같은 CSP를 응답에도 단다.
//    캐시 화면(A)은 요청 값 없이 같은 헤더를 단다. 막는 CSP는 앞 서버(server/csp-hash-server.mjs)가 HTML의 인라인 스크립트 해시를
//    채워 단다(응답 때 해시, ADR-0193). CDN은 본문과 그 CSP를 함께 캐시한다.
//    개발 서버(next dev)는 HMR이 인라인·eval 스크립트를 쓰므로 CSP를 보고 모드로만 단다.
// ② 본인확인 복귀 화면의 서버 처리기(docs/features/identity.md §5 '복귀 화면의 서버 처리기', BUILD_ORDER BOT-010).
import { NextResponse, type NextRequest } from 'next/server';
import { NONCE_HEADER, cachedCsp, matchRoute, newNonce, pageHeaders } from './src/_app/security/page-headers.ts';
import { verifyReturnProxy } from './src/features/identity-verify/server/return-post.ts';

const dev = process.env.NODE_ENV === 'development';

/** 환경마다 다른 API 출처(로컬 실행 등). 없으면 운영 출처(security-headers.mjs PROD_ORIGINS) */
function cspOrigins(): Record<string, string> | undefined {
  const raw = process.env.PEAKET_CSP_ORIGINS;
  if (!raw) return undefined;
  const o: unknown = JSON.parse(raw);
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TypeError('PEAKET_CSP_ORIGINS는 JSON 객체여야 한다');
  return o as Record<string, string>;
}
const origins = cspOrigins();

/**
 * 손님이 실어 보낸 CSP·nonce 요청 머리를 지운다. Next.js는 요청 CSP의 nonce를 스크립트에 붙이므로, 남겨 두면 손님이 고른 값이
 * 캐시 화면 HTML에 들어가 CDN에 캐시될 수 있다(요청 화면은 아래에서 서버가 만든 값으로 덮는다)
 */
function stripSpoofed(h: Headers): Headers {
  // Next.js는 content-security-policy가 없으면 content-security-policy-report-only에서도 nonce를 읽는다
  h.delete('content-security-policy');
  h.delete('content-security-policy-report-only');
  h.delete(NONCE_HEADER);
  return h;
}

/** 화면 헤더를 응답에 단다. 개발 서버에서는 CSP를 보고 모드로 바꾼다 */
function applyHeaders(res: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [k, v] of Object.entries(headers)) {
    if (dev && k === 'Content-Security-Policy') res.headers.set('Content-Security-Policy-Report-Only', v);
    else res.headers.set(k, v);
  }
  return res;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (pathname === '/verify/return') {
    const d = await verifyReturnProxy(req);
    if (d.kind === 'reject') {
      return new NextResponse(d.status === 405 ? 'POST·GET만 받습니다' : '본인확인 결과 값이 틀렸습니다', {
        status: d.status,
        headers: { ...d.responseHeaders, 'content-type': 'text/plain; charset=utf-8', ...(d.status === 405 ? { allow: 'GET, HEAD, POST' } : {}) },
      });
    }
    stripSpoofed(d.requestHeaders);
    const res = applyHeaders(NextResponse.next({ request: { headers: d.requestHeaders } }), { ...pageHeaders(pathname)!, ...cachedCsp(pathname, { origins }) });
    for (const [k, v] of Object.entries(d.responseHeaders)) res.headers.set(k, v);
    return res;
  }

  const rule = matchRoute(pathname);
  if (rule?.kind === 'route') return NextResponse.next({ request: { headers: stripSpoofed(new Headers(req.headers)) } });

  // 경로 표에 없는 주소(없는 화면의 404 등)는 캐시 화면처럼 헤더와 CSP 틀을 단다(page-headers.ts FALLBACK)
  if (!rule || rule.group === 'cached') {
    const requestHeaders = stripSpoofed(new Headers(req.headers));
    return applyHeaders(NextResponse.next({ request: { headers: requestHeaders } }), { ...pageHeaders(pathname, { origins })!, ...cachedCsp(pathname, { origins }) });
  }

  const nonce = newNonce();
  const headers = pageHeaders(pathname, { nonce, origins })!;
  const requestHeaders = stripSpoofed(new Headers(req.headers));
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']!);
  return applyHeaders(NextResponse.next({ request: { headers: requestHeaders } }), headers);
}

// 정적 자산·텔레메트리 입구(/_t/*, 게이트웨이 수집기로 간다)·public/의 자산 확장자 파일만 건너뛴다.
// 마지막 조각에 점이 든 화면 주소(/events/a.b 등)와 없는 주소의 404도 헤더를 받게, 확장자는 자산 종류로만 좁힌다
export const config = {
  matcher: ['/((?!_next/static|_next/image|_t/|.*\\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|txt|json|webmanifest|xml)$).*)'],
};
