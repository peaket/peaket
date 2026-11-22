// 파트너 콘솔 운영 빌드의 화면 보안 헤더(F-03-1 OPS-340 T11, docs/frontend.md §5.14.1 '[B 파트너 콘솔]'·'Trusted Types' 붙인 곳, ADR-0360 결정 7).
// proxy.ts가 위저드·에디터 두 경로만이 아니라 모든 화면 경로에 묶음 B 파트너 CSP·PAGE_HEADERS.partner·Trusted Types 보고 모드 이름 목록을 다는지 운영 서버 응답으로 본다.
// 좁은 기본 정책은 브라우저에서 같은 출처 /_next/static/ .js 주소만 통과시키는지 본다. 위저드의 Next.js 덩어리 위반 0은 rich-text(FE-T41, T10)가 본다.
import { test, expect } from '@playwright/test';
import { PAGE_HEADERS, REPORTING_ENDPOINTS, renderCsp } from '../../../packages/config/headers/security-headers.mjs';
import { PARTNER_PORT } from '../playwright.console-csp.config.mjs';

const BASE = `http://127.0.0.1:${PARTNER_PORT}`;
const PARTNER_POLICIES = ['peaket', 'peaket-paste', 'nextjs', 'default'];
const UUID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
/** 위저드 밖 화면 셋 이상 포함(로그인·공연 목록·정산·좌석맵 에디터·없는 화면) */
const PAGES = ['/login', '/events', '/settlements', '/events/new', `/events/${UUID}/seatmap`, '/no-such-screen'];

const withoutNonce = (csp) => csp.replace(/'nonce-[^']+'/g, "'nonce-N'");

test('F-03-1 T11 [ASVS v5.0.0-3.4.3][ASVS v5.0.0-3.4.5][ASVS v5.0.0-3.4.6][ASVS v5.0.0-3.4.7][ASVS v5.0.0-3.4.8][ASVS v5.0.0-3.7.1] 파트너 화면 응답(위저드 밖 포함)이 renderCsp(B, partner)·PAGE_HEADERS.partner·Trusted Types 이름 목록을 단다', async ({ request }) => {
  const want = withoutNonce(renderCsp('B', { nonce: 'N'.repeat(24), variants: ['partner'] }));
  for (const path of PAGES) {
    const res = await request.get(`${BASE}${path}`, { maxRedirects: 0 });
    const h = res.headers();
    expect(h['content-security-policy'], `${path} CSP`).toBeDefined();
    expect(withoutNonce(h['content-security-policy']), path).toBe(want);
    expect(h['content-security-policy'], path).toMatch(/object-src 'none'/);
    expect(h['content-security-policy'], path).toMatch(/frame-ancestors 'none'/);
    expect(h['content-security-policy'], path).toMatch(/report-to csp/);
    expect(h['content-security-policy-report-only'], path).toBe(`require-trusted-types-for 'script'; trusted-types ${PARTNER_POLICIES.join(' ')}; report-to csp`);
    expect(h['reporting-endpoints'], path).toBe(REPORTING_ENDPOINTS);
    for (const [k, v] of Object.entries(PAGE_HEADERS.partner)) expect(h[k.toLowerCase()], `${path} ${k}`).toBe(v);
    expect(h['referrer-policy'], path).toBe('no-referrer');
    expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
    // proxy가 private, no-store를 달고, 요청 때 그리는 화면은 Next.js가 같은 뜻을 더 적은 값으로 바꿔 쓴다(공유 캐시·저장 금지는 같다)
    const cache = (h['cache-control'] ?? '').split(',').map((s) => s.trim());
    expect(cache, `${path} Cache-Control ${h['cache-control']}`).toEqual(expect.arrayContaining(['private', 'no-store']));
    expect(cache.filter((d) => d === 'public' || d.startsWith('s-maxage')), path).toEqual([]);
  }
  // 정적 자산·기본 정책 파일에는 화면 헤더가 걸리지 않는다(matcher 밖)
  const asset = await request.get(`${BASE}/trusted-types-default.js`);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['content-security-policy']).toBeUndefined();
});

test('F-03-1 T10 FE-T41 위저드 밖 화면에서도 좁은 기본 정책이 먼저 생기고 같은 출처 /_next/static/ .js만 통과시킨다(nonce·무결성으로 실린다)', async ({ page }) => {
  const res = await page.goto(`${BASE}/settlements`);
  const html = await res.text();
  const csp = res.headers()['content-security-policy'];
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  // 루트 레이아웃이 <head> 맨 앞에 요청 nonce·SHA-384로 싣는다
  expect(html).toMatch(new RegExp(`<script src="/trusted-types-default\\.js" nonce="${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}" integrity="sha384-[A-Za-z0-9+/=]+"`));
  const verdict = await page.evaluate(() => {
    const p = window.trustedTypes?.defaultPolicy;
    if (!p) return null;
    const pass = (u) => {
      try {
        return String(p.createScriptURL(u));
      } catch {
        return 'thrown';
      }
    };
    const html = (() => {
      try {
        p.createHTML('<img src=x onerror=alert(1)>');
        return 'made';
      } catch {
        return 'thrown';
      }
    })();
    return { same: pass('/_next/static/chunks/a.js'), other: pass('https://evil.example/_next/static/chunks/a.js'), css: pass('/_next/static/chunks/a.css'), html };
  });
  expect(verdict).not.toBeNull();
  expect(verdict.same).toBe('/_next/static/chunks/a.js');
  // 목록 밖은 값을 주지 않는다(null → 빈 값 또는 'null' 글), HTML 규칙은 없다
  for (const k of ['other', 'css']) expect(['', 'null', 'thrown'], `${k}: ${verdict[k]}`).toContain(verdict[k]);
  expect(verdict.html).toBe('thrown');
});
