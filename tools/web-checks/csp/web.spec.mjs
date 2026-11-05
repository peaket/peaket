// 소비자 웹 CSP PoC와 시험(docs/frontend.md §2.5·§5.14.1·§6.3, ADR-0065 결정 4, ADR-0111, BUILD_ORDER HOT-290).
// 운영 빌드(`node seed-css/build.mjs web`, Cache Components·SRI 켬)를 운영과 같은 proxy.ts 헤더로 띄워 세 엔진에서 연다.
// - FE-T35: (request) 묶음 화면은 정적 셸이 없고, 응답의 모든 <script>에 그 응답의 nonce가 붙고, 두 요청의 nonce가 다르며,
//   CSP를 끄지 않고(bypassCSP 없이) 열어 위반이 0이다. 묶음 사이 이동은 전체 이동, 같은 묶음 안은 페이지 안 이동이다.
// - FE-T30: 서버가 그린 style 속성은 style-src-attr로 살아 계산된 스타일이 CSP를 끈 것과 같고, nonce 없는 <style>·인라인 스크립트는 막힌다.
// - SRI PoC(캐시 화면 A): Next.js 해시 방식은 외부 스크립트에 integrity를 달지만 App Router 인라인 스크립트는 덮지 않는다.
//   빌드 때 HTML의 인라인 스크립트 해시로 막는 CSP를 걸어, 통째로 정적인 화면과 요청 때 채우는 화면에서 어떻게 되는지 남긴다.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCsp } from '../../../packages/config/headers/security-headers.mjs';
import { HOST, MOCK_API } from '../seed-css/apps.mjs';
import { WEB_BASE, WEB_BUILD_DIR } from './pages.mjs';

const EVENT = 'evt-lumen-1025';
/** 공연 상세는 가짜 API 고정 자료의 회차(HOT-311) */
// 판매 중지 시험은 다른 시험이 그리지 않은 회차를 쓴다(ISR이 그린 화면을 300초 기억한다)
const SUSPENDED_EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02';
const DETAIL_EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
/** (request) 묶음 화면: 묶음 B·E·F, 사람 확인 변형 */
const REQUEST_PAGES = ['/my/settings', '/login', `/booking/${EVENT}/seats`, `/booking/${EVENT}/checkout`, `/queue/${EVENT}/verify`, '/shop/checkout', '/signup/consent'];
/** (request) 묶음의 사전 렌더 목록 이름(빌드 산출물의 정적 셸 검사) */
const REQUEST_ROUTES = ['/my/settings', '/login', '/booking/[eventId]/seats', '/booking/[eventId]/checkout', '/queue/[eventId]/verify', '/shop/checkout', '/signup/consent'];

/** 페이지가 받은 CSP 위반(브라우저 securitypolicyviolation 사건)을 모은다. 보고 모드 위반도 사건이 나서 disposition으로 가른다 */
async function trackViolations(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition, sample: (e.sample || '').slice(0, 60) });
    });
  });
  return async () => page.evaluate(() => window.__csp);
}

/** 가로챈 응답을 바이트 그대로(UTF-8) 내보낸다. 문자열로 넘기면 WebKit이 한글을 다른 인코딩으로 읽어 스크립트 글자가 달라진다 */
const fulfillHtml = (route, res, html, extra = {}) => {
  const headers = { ...res.headers(), ...extra, 'content-type': 'text/html; charset=utf-8' };
  delete headers['content-length'];
  return route.fulfill({ status: res.status(), headers, body: Buffer.from(html, 'utf8') });
};

const inlineScripts = (html) => [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const sha256 = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

test.describe('FE-T35 (request) 묶음: 정적 셸 없음·응답마다 nonce', () => {
  test('FE-T35 빌드 산출물에 (request) 경로의 정적 셸이 없다(사전 렌더 HTML 0바이트, 요청 때 그림)', async ({ browserName }) => {
    test.skip(browserName !== 'chromium', '빌드 산출물 검사는 엔진과 상관없다');
    const file = join(WEB_BUILD_DIR, 'prerender-manifest.json');
    test.skip(!existsSync(file), `빌드 산출물이 없다: ${file}`);
    const m = JSON.parse(readFileSync(file, 'utf8'));
    const all = { ...m.routes, ...m.dynamicRoutes };
    for (const r of REQUEST_ROUTES) {
      const e = all[r];
      if (!e) continue; // 사전 렌더 목록에 없으면 정적 셸도 없다
      expect.soft(`${r} ${e.htmlSize ?? 0} ${e.compute ?? ''}`).toBe(`${r} 0 blocking`);
    }
  });

  for (const path of REQUEST_PAGES) {
    test(`FE-T35 ${path}: 모든 <script>에 그 응답의 nonce, 두 요청의 nonce가 다르다`, async ({ request, browserName }) => {
      test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
      const nonces = [];
      for (let i = 0; i < 2; i++) {
        const res = await request.get(`${WEB_BASE}${path}`);
        expect(res.status()).toBe(200);
        const csp = res.headers()['content-security-policy'];
        const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? '')?.[1];
        expect(nonce, csp).toBeTruthy();
        const html = await res.text();
        const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((x) => x[1]);
        expect(tags.length).toBeGreaterThan(0);
        expect(tags.filter((a) => !a.includes(`nonce="${nonce}"`))).toEqual([]);
        nonces.push(nonce);
      }
      expect(nonces[0]).not.toBe(nonces[1]);
    });

    test(`FE-T35 ${path}: CSP를 켠 채 열어 위반 0, 페이지 오류 0`, async ({ page }) => {
      const violations = await trackViolations(page);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const res = await page.goto(`${WEB_BASE}${path}`);
      expect(res.headers()['content-security-policy']).toContain("'strict-dynamic'");
      await page.waitForLoadState('networkidle');
      expect(await violations()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('FE-T35 같은 묶음 안 이동은 페이지 안 이동, 묶음 사이 이동은 전체 이동이다', async ({ page }) => {
    await page.goto(`${WEB_BASE}/my/settings`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => (window.__stay = 1));
    await page.locator('a[href="/my/settings/providers"]').first().click();
    await page.waitForURL('**/my/settings/providers');
    expect(await page.evaluate(() => window.__stay)).toBe(1);
    // 홈 링크는 화면 폭에 따라 접힌 메뉴 안에 있을 수 있어, 보이는 것과 상관없이 그 링크의 누르기(Next.js Link가 받는다)로 옮긴다
    await page.locator('a[href="/"]').first().evaluate((a) => a.click());
    await page.waitForURL(`${WEB_BASE}/`);
    expect(await page.evaluate(() => window.__stay)).toBeUndefined();
  });
});

test.describe('FE-T30 style 속성과 nonce 없는 요소(ADR-0111)', () => {
  test('FE-T30 서버가 그린 style 속성은 CSP를 켠 것과 끈 것의 계산된 스타일이 같고 style-src-attr 위반이 0이다', async ({ browser }) => {
    const path = '/my/settings';
    const styles = async (ctx) => {
      const page = await ctx.newPage();
      const violations = await trackViolations(page);
      await page.goto(`${WEB_BASE}${path}`);
      await page.waitForLoadState('networkidle');
      const out = await page.evaluate(() =>
        [...document.querySelectorAll('[style]')].map((el) => {
          const cs = getComputedStyle(el);
          return [el.getAttribute('style'), cs.width, cs.height, cs.marginTop, cs.paddingLeft, cs.color, cs.backgroundColor, cs.gap, cs.display].join('|');
        }),
      );
      return { out, v: await violations() };
    };
    const on = await browser.newContext();
    const off = await browser.newContext({ bypassCSP: true });
    const a = await styles(on);
    const b = await styles(off);
    expect(a.out.length).toBeGreaterThan(0);
    expect(a.out).toEqual(b.out);
    expect(a.v.filter((x) => x.directive === 'style-src-attr')).toEqual([]);
    await on.close();
    await off.close();
  });

  test('FE-T30 nonce 없는 <style>과 인라인 스크립트는 막힌다(응답 HTML에 끼워 넣어도)', async ({ page }) => {
    await page.route(`${WEB_BASE}/my/settings`, async (route) => {
      const res = await route.fetch();
      const html = (await res.text()).replace('</head>', '<style id="evil">body{outline:7px solid red}</style><script>window.__evil=1</script></head>');
      await fulfillHtml(route, res, html);
    });
    const violations = await trackViolations(page);
    await page.goto(`${WEB_BASE}/my/settings`);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => window.__evil)).toBeUndefined();
    // 막혔으면 outline이 없다(outline-width는 테두리가 없어도 기본값 medium을 돌려주는 엔진이 있어 style로 본다)
    expect(await page.evaluate(() => getComputedStyle(document.body).outlineStyle)).not.toBe('solid');
    const v = await violations();
    expect(v.some((x) => x.directive.startsWith('script-src'))).toBe(true);
    expect(v.some((x) => x.directive.startsWith('style-src'))).toBe(true);
  });
});

test.describe('SRI PoC: 캐시 화면(A)의 인라인 스크립트', () => {
  test('SRI PoC 외부 스크립트에는 integrity가 붙고, 인라인 스크립트는 남는다(해시 방식이 덮지 못한다)', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', 'HTML 검사는 엔진과 상관없다');
    const html = await (await request.get(`${WEB_BASE}/system-notice`)).text();
    const external = [...html.matchAll(/<script\b([^>]*\ssrc=[^>]*)>/g)].map((m) => m[1]);
    const withIntegrity = external.filter((a) => /integrity="sha256-/.test(a));
    console.log(`SRI PoC /system-notice: 외부 스크립트 ${external.length}개 중 integrity ${withIntegrity.length}개, 인라인 ${inlineScripts(html).length}개`);
    expect(withIntegrity.length).toBeGreaterThan(0);
    expect(inlineScripts(html).length).toBeGreaterThan(0);
  });

  test('SRI PoC 통째로 정적인 화면은 빌드 때 HTML의 인라인 스크립트 해시로 막는 CSP를 걸어도 위반 0이다', async ({ page, browserName }) => {
    // Playwright WebKit의 응답 가로채기(route.fulfill)는 바이트로 넘겨도 한글 본문의 글자를 바꿔(스크립트 2262→2288자) 해시 비교에 쓸 수 없다.
    // WebKit에서 실제 응답의 해시가 맞는지는 아래 '캐시 화면(A) 응답 때 해시' 시험이 가로채지 않고 본다
    test.skip(browserName === 'webkit', 'Playwright WebKit 응답 가로채기가 본문 글자를 바꾼다(2026-11-04 확인)');
    const path = '/system-notice';
    await page.route(`${WEB_BASE}${path}`, async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      const csp = renderCsp('A', { hashes: inlineScripts(body).map(sha256) });
      await fulfillHtml(route, res, body, { 'content-security-policy': csp });
    });
    const violations = await trackViolations(page);
    await page.goto(`${WEB_BASE}${path}`);
    await page.waitForLoadState('networkidle');
    expect((await violations()).filter((v) => v.disposition === 'enforce')).toEqual([]);
  });

});

test.describe('캐시 화면(A) 응답 때 해시(ADR-0193)', () => {
  const CACHED_PAGES = ['/', `/events/${DETAIL_EVENT}`, '/search', '/system-notice', '/my/tickets', '/policy/terms'];
  for (const path of CACHED_PAGES) {
    test(`[ASVS v5.0.0-3.4.3] ${path}: 앞 서버가 HTML의 인라인 스크립트 해시로 막는 CSP를 달고, 세 엔진에서 위반 0`, async ({ page, request, browserName }) => {
      if (browserName === 'chromium') {
        const res = await request.get(`${WEB_BASE}${path}`);
        const h = res.headers();
        const html = await res.text();
        expect(h['x-peaket-csp-template'], '안쪽 머리가 밖으로 새면 안 된다').toBeUndefined();
        expect(h['content-security-policy-report-only']).toBeUndefined();
        const csp = h['content-security-policy'] ?? '';
        expect(csp).toMatch(/^default-src 'self'; script-src 'self'/);
        expect(csp).not.toContain('PEAKET+INLINE');
        for (const s of inlineScripts(html)) expect(csp).toContain(sha256(s));
      }
      const violations = await trackViolations(page);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${WEB_BASE}${path}`);
      await page.waitForLoadState('networkidle');
      expect(await violations()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('[ASVS v5.0.0-3.4.3] 손님이 실어 보낸 CSP·x-nonce 요청 머리는 화면에 쓰이지 않는다(캐시 화면은 nonce 속성 없음, 요청 화면은 서버가 만든 nonce)', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
    const spoof = {
      'content-security-policy': "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAAAA'",
      'content-security-policy-report-only': "script-src 'nonce-BBBBBBBBBBBBBBBBBBBBBBBB'",
      'x-nonce': 'AAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const cachedHtml = await (await request.get(`${WEB_BASE}/search`, { headers: spoof })).text();
    expect(cachedHtml).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
    // 보고 모드 머리만 보내도 Next.js가 그 nonce를 읽는다(CSP 머리가 없을 때)
    const onlyRo = await (await request.get(`${WEB_BASE}/search`, { headers: { 'content-security-policy-report-only': spoof['content-security-policy-report-only'] } })).text();
    expect(onlyRo).not.toContain('BBBBBBBBBBBBBBBBBBBBBBBB');
    const res = await request.get(`${WEB_BASE}/my/settings`, { headers: spoof });
    expect(res.headers()['content-security-policy']).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await res.text()).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  test('[ASVS v5.0.0-3.4.3] 캐시 화면의 화면 데이터 요청(RSC)과 정적 자산에는 CSP 틀이 새지 않는다', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
    const rsc = await request.get(`${WEB_BASE}/search`, { headers: { RSC: '1' } });
    expect(rsc.headers()['x-peaket-csp-template']).toBeUndefined();
    expect(rsc.headers()['content-security-policy']).toBeUndefined();
  });
});

test.describe('빠진 화면 없이 헤더·상태 코드(HOT-290 새 맥락 리뷰)', () => {
  test('[ASVS v5.0.0-3.4.3] 없는 화면 주소는 404, 화면이 요청 때 notFound()를 부르면 Cache Components에서 200+noindex다. 둘 다 막는 CSP와 frame-ancestors를 받는다', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
    const cases = [
      ['/no/such/page', 404],
      // 요청 때 그리는 화면의 notFound()는 본문이 흐른 뒤라 200에 noindex다(Next.js 'Status codes'). 404로 내는 일은 데이터를 잇는 단계가 한다(docs/frontend.md §2.5)
      ['/policy/no-such-doc', 200],
    ];
    for (const [path, status] of cases) {
      const res = await request.get(`${WEB_BASE}${path}`);
      expect(res.status(), path).toBe(status);
      if (status === 200) expect(await res.text(), path).toMatch(/<meta name="robots" content="noindex/);
      expect(res.headers()['cache-control'] ?? '', `${path}는 CDN에 캐시되지 않는다`).toContain('no-store');
      const csp = res.headers()['content-security-policy'] ?? '';
      expect(csp, path).toMatch(/^default-src 'self'; script-src 'self'/);
      expect(csp, path).toContain("frame-ancestors 'none'");
    }
  });

  test('[ASVS v5.0.0-3.4.3] 마지막 조각에 점이 든 화면 주소도 proxy를 거쳐 헤더를 받는다', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
    const cached = await request.get(`${WEB_BASE}/events/evt.lumen.1025`);
    expect(cached.headers()['content-security-policy'] ?? '').toMatch(/^default-src 'self'; script-src 'self'/);
    const req = await request.get(`${WEB_BASE}/my/orders/ord.1`);
    expect(req.status()).not.toBe(500);
    expect(req.headers()['content-security-policy'] ?? '').toContain("'strict-dynamic'");
  });
});

test.describe('공연 상세의 404·410 상태 코드(ADR-0201, HOT-311)', () => {
  /** 가짜 API는 127.0.0.1 이름에만 답한다. 컨테이너에서 돌면(HOST가 host.docker.internal) 상태를 바꿀 수 없어 건너뛴다 */
  const MOCK = `http://127.0.0.1:${MOCK_API.port}`;
  test('없는 회차·모양이 틀린 ID·확장자 붙은 주소는 404, 대문자 ID는 소문자로 308, 판매 중지된 회차는 410이고 판매 중지 안내를 그린다', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
    test.skip(HOST !== '127.0.0.1', '가짜 API 상태 바꾸기는 이 PC에서만');
    // 확장자가 붙은 주소도 proxy를 거쳐 걸러진다(자산 확장자 범위 밖, HOT-311 리뷰)
    for (const id of ['00000000-0000-4000-8000-0000000000aa', 'not-a-uuid', 'zz.json', 'zz.png']) {
      const res = await request.get(`${WEB_BASE}/events/${id}`);
      expect(res.status(), id).toBe(404);
      expect(res.headers()['content-security-policy'] ?? '', id).toMatch(/^default-src 'self'; script-src 'self'/);
    }
    // 대문자 ID는 소문자 주소로 옮기고, 상세·홈 응답은 ISR 태그와 같은 CDN 태그 머리를 싣는다(docs/infra.md §4.1)
    const upper = await request.get(`${WEB_BASE}/events/${DETAIL_EVENT.toUpperCase()}`, { maxRedirects: 0 });
    expect(upper.status()).toBe(308);
    expect(upper.headers().location ?? '').toContain(`/events/${DETAIL_EVENT}`);
    const detail = await request.get(`${WEB_BASE}/events/${DETAIL_EVENT}`);
    expect(detail.headers()['x-peaket-cache-tag']).toBe(`event:${DETAIL_EVENT},production:0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4d01`);
    expect((await request.get(`${WEB_BASE}/`)).headers()['x-peaket-cache-tag']).toBe('home');
    await request.get(`${MOCK}/__mock/state?detail=suspended`);
    try {
      const gone = await request.get(`${WEB_BASE}/events/${SUSPENDED_EVENT}`);
      expect(gone.status()).toBe(410);
      expect(gone.headers()['cache-control']).toBe('public, max-age=60');
      expect(await gone.text()).toContain('판매가 중지된 공연입니다');
    } finally {
      await request.get(`${MOCK}/__mock/state?detail=normal`);
    }
  });
});

test.describe('SRI 값과 소스 맵 링크(HOT-291 숨김 소스 맵)', () => {
  for (const path of ['/', '/my/settings', '/system-notice']) {
    test(`[ASVS v5.0.0-13.4.7] ${path}: 모든 integrity가 내려받은 파일의 SHA-256과 같고, 받은 JS에 소스 맵 링크가 없다`, async ({ request, browserName }) => {
      test.skip(browserName !== 'chromium', 'HTTP 응답 검사는 엔진과 상관없다');
      const html = await (await request.get(`${WEB_BASE}${path}`)).text();
      const tags = [...html.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]+\.js)"[^>]*\sintegrity="(sha256-[^"]+)"/g)];
      expect(tags.length).toBeGreaterThan(0);
      for (const [, url, integrity] of tags) {
        const body = await (await request.get(`${WEB_BASE}${url}`)).body();
        expect(`sha256-${createHash('sha256').update(body).digest('base64')}`, url).toBe(integrity);
        expect(body.toString('utf8'), url).not.toMatch(/sourceMappingURL=/);
      }
    });
  }
});
