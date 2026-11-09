// 파트너 콘솔 proxy: 지금은 서식 글 편집기 PoC(FE-T41, BUILD_ORDER HOT-322) 경로 하나만 맡는다. 화면 보안 헤더 전체는 OPS-340(관제·파트너 콘솔 CSP와 보안 헤더)이 단다.
// PoC 경로(/poc/rich-text)는 PoC 빌드(PEAKET_POC=rich-text)에만 있다(next.config.ts pageExtensions). 운영 빌드에서는 이 주소가 404다.
// 개발 서버(next dev)는 소비자 웹 proxy와 같게 CSP를 보고 모드로 단다(개발 도구의 인라인 스크립트).
// 묶음 B CSP(요청마다 nonce, 'strict-dynamic', 파트너 변형)를 응답과 요청 머리에 싣는다(Next.js가 요청 CSP의 nonce를 스크립트에 붙인다).
// Trusted Types는 보고 모드로 싱크 위반만 센다(정책 이름은 묻지 않는다, docs/frontend.md FE-T41).
import { NextResponse, type NextRequest } from 'next/server';
import { REPORTING_ENDPOINTS, renderCsp } from '@peaket/config/headers/security-headers.mjs';

function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b));
}

export function proxy(req: NextRequest) {
  const nonce = newNonce();
  const csp = renderCsp('B', { nonce, variants: ['partner'] });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete('content-security-policy-report-only');
  requestHeaders.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  const tt = "require-trusted-types-for 'script'; report-to csp";
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Content-Security-Policy', csp);
    res.headers.set('Content-Security-Policy-Report-Only', tt);
  } else res.headers.set('Content-Security-Policy-Report-Only', `${csp}, ${tt}`);
  res.headers.set('Reporting-Endpoints', REPORTING_ENDPOINTS);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

export const config = { matcher: ['/poc/rich-text'] };
