// SCR-058 인앱 브라우저 감지·외부 브라우저 안내를 부르는 쪽 시험(docs/design/d5-screen-blueprint.md §5.32, docs/frontend.md §1.5 '인앱 브라우저' 행, NFR-019).
// 판정 함수(apps/web/src/shared/lib/in-app-browser.test.mjs)만이 아니라, 운영 빌드의 화면이 그 결과를 실제로 쓰는지 바깥 경계(링크 주소)에서 본다.
// - 공연 상세 ⑦ [로비 입장]: 인앱 브라우저면 /open-in-browser?next=<대기실 경로>, 일반 브라우저면 대기실 경로 그대로
// - 안내 화면에 다른 출처 next를 주면 그 출처로 가는 주소를 싣지 않는다
// 로비 단계는 검사용 가짜 API의 상태 바꾸기 queueOpenIn(오픈까지 남은 초)으로 만든다(ADR-0208).
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 썼다(ADR-0270 결정 3). 실행은 웨이브 끝 무거운 게이트(계획 §7).
import { test, expect } from '@playwright/test';
import { APPS, HOST, MOCK_API_ORIGIN, portOf } from '../seed-css/apps.mjs';
import { stubFanApi } from '../csp/pages.mjs';

const WEB = `http://${HOST}:${portOf(APPS.find((a) => a.name === 'web'), 'prod')}`;
/** 다른 시험이 그리지 않는 회차(ISR이 그린 화면을 기억하므로 로비 단계로 바꾼 회차를 따로 쓴다). 가짜 API 고정 자료 'play'(HYBRID) */
const EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e06';

/** apps/web/src/shared/lib/in-app-browser.ts가 아는 인앱 브라우저마다 하나 */
const IN_APP = {
  KakaoTalk: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.2',
  Instagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0',
  Facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0]',
  NAVER: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 NAVER(inapp; search; 1000; 12.0.0)',
  LINE: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.0.0',
  Band: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Band/14.0.0',
  TikTok: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 musical_ly_2026.1.0',
  X: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone',
};
/** NFR-019 지원 브라우저(d5 §5.32): 안내 없이 그대로 간다 */
const BROWSERS = {
  Chrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  Safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Samsung Internet': 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  Edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  Whale: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Whale/4.29.282.14 Safari/537.36',
  Firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
};

const mockState = async (q) => {
  const r = await fetch(`${MOCK_API_ORIGIN}/__mock/state?${q}`);
  expect(r.status, `가짜 API 상태 바꾸기 ${q}`).toBe(200);
};

test.beforeAll(async () => {
  // 오픈 5분 전 = 로비 열림(로비는 오픈 10분 전부터, 가짜 API LOBBY_MINUTES)
  await mockState('queueOpenIn=300');
});
test.afterAll(async () => {
  await mockState('queueOpenIn=');
});

/** 그 User-Agent로 공연 상세를 열고 [로비 입장] 링크의 주소를 읽는다 */
async function lobbyHref(browser, userAgent) {
  const context = await browser.newContext({ userAgent, locale: 'ko-KR' });
  try {
    const page = await context.newPage();
    await stubFanApi(page);
    const res = await page.goto(`${WEB}/events/${EVENT}`, { waitUntil: 'networkidle' });
    expect(res?.status()).toBeLessThan(400);
    const link = page.getByRole('link', { name: '로비 입장' });
    await expect(link, '로비 입장 링크가 없다(빈 결과)').toBeVisible({ timeout: 15_000 });
    // 인앱 판별은 클라이언트가 붙은 뒤에 바뀐다(서버 첫 그리기는 원래 주소). 바뀔 시간을 준 뒤 읽는다
    await page.waitForTimeout(500);
    return await link.getAttribute('href');
  } finally {
    await context.close();
  }
}

const queuePath = `/queue/${EVENT}`;
const guided = `/open-in-browser?next=${encodeURIComponent(queuePath)}`;

test('SCR-058 기본 폭: 인앱 브라우저(KakaoTalk·Instagram·Facebook·NAVER·LINE·Band·TikTok·X)에서 공연 상세 로비 입장은 안내 주소로 간다', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'User-Agent로 가르는 화면 판단이라 엔진과 상관없다');
  for (const [name, ua] of Object.entries(IN_APP)) {
    const href = await lobbyHref(browser, ua);
    expect(href, name).not.toBeNull();
    expect(new URL(href, WEB).pathname + new URL(href, WEB).search, name).toBe(guided);
  }
});

test('SCR-058 기본 폭: 일반 브라우저(Chrome·Safari·Samsung Internet·Edge·Whale·Firefox)는 그대로 간다', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'User-Agent로 가르는 화면 판단이라 엔진과 상관없다');
  for (const [name, ua] of Object.entries(BROWSERS)) {
    const href = await lobbyHref(browser, ua);
    expect(href, name).not.toBeNull();
    const u = new URL(href, WEB);
    expect(u.pathname, name).toBe(queuePath);
    expect(u.pathname.startsWith('/open-in-browser'), name).toBe(false);
  }
});

test('SCR-058 기본 폭: 안내 화면의 next가 다른 출처면 그 출처로 가는 주소를 싣지 않는다', async ({ page }) => {
  await stubFanApi(page);
  for (const next of ['https://evil.example/queue/x', '//evil.example/queue/x', '/\\evil.example/queue/x']) {
    const res = await page.goto(`${WEB}/open-in-browser?next=${encodeURIComponent(next)}`, { waitUntil: 'networkidle' });
    expect(res?.status(), next).toBeLessThan(400);
    // 안내 화면 자체는 그린다(빈 화면으로 통과하지 않게)
    await expect(page.getByRole('button', { name: '주소 복사' }), next).toBeVisible();
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll('*')].flatMap((el) =>
        ['href', 'action', 'formaction', 'data-href', 'data-url', 'src'].map((a) => el.getAttribute(a)).filter((v) => typeof v === 'string'),
      ),
    );
    expect(targets.filter((v) => v.includes('evil.example')), next).toEqual([]);
  }
});

// BAT-170 시험 뒤 정한 것(계획 §11 3, docs/design/d5-screen-blueprint.md §5.32 '열 주소'): 시험 담당(l2w7-BAT170-test)이 구현 전에 더했다.
// [주소 복사]가 복사한 값(navigator.clipboard.writeText 대역)과 Android의 [다른 브라우저로 열기]가 요청한 이동(intent 주소, CDP Page.frameRequestedNavigation)을 읽는다.
/** Android 인앱 브라우저(Instagram): [다른 브라우저로 열기]가 intent 주소로 바로 연다 */
const ANDROID_IN_APP = IN_APP.Instagram;

/** intent://host/path?q#Intent;scheme=http;end → http://host/path?q */
const fromIntent = (u) => {
  const m = /^intent:\/\/([^#]*)#Intent;(?:.*;)?scheme=([a-z]+);/.exec(u);
  return m ? `${m[2]}://${m[1]}` : u;
};

async function guideAddresses(browser, next) {
  const context = await browser.newContext({ userAgent: ANDROID_IN_APP, locale: 'ko-KR' });
  try {
    const page = await context.newPage();
    await stubFanApi(page);
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => void window.__copied.push(String(t)) } });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    const opened = [];
    cdp.on('Page.frameRequestedNavigation', (e) => opened.push(e.url));
    const res = await page.goto(`${WEB}/open-in-browser?next=${encodeURIComponent(next)}`, { waitUntil: 'networkidle' });
    expect(res?.status(), next).toBeLessThan(400);
    await page.getByRole('button', { name: '주소 복사' }).first().click();
    await expect.poll(() => page.evaluate(() => window.__copied.length), { message: `${next} 복사한 값이 없다(빈 결과)` }).toBeGreaterThan(0);
    const copied = await page.evaluate(() => window.__copied);
    await page.getByRole('button', { name: '다른 브라우저로 열기' }).click();
    await expect.poll(() => opened.filter((u) => u.startsWith('intent:')).length, { message: `${next} 바로 열기 이동이 없다(빈 결과)` }).toBeGreaterThan(0);
    const text = await page.locator('body').innerText();
    return { copied, opened: opened.filter((u) => u.startsWith('intent:')).map(fromIntent), text };
  } finally {
    await context.close();
  }
}

test('SCR-058 기본 폭: 다른 출처·두 꼴 밖 next면 [다른 브라우저로 열기]·[주소 복사]의 주소는 첫 화면(/)이다', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP 이동 요청 사건은 Chromium만 된다');
  for (const next of ['https://evil.example/queue/x', '//evil.example/queue/x', '/my/settings']) {
    const { copied, opened, text } = await guideAddresses(browser, next);
    expect(copied, next).toEqual([`${WEB}/`]);
    expect(opened, next).toEqual([`${WEB}/`]);
    expect(text.includes('evil.example'), `${next} 받은 주소가 화면 글에 있다`).toBe(false);
  }
});

test('SCR-058 기본 폭: 고정 자료에 없는 실제 공연 ID의 대기실 경로는 그 주소 그대로 연다(데모 공연으로 바꾸지 않는다)', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP 이동 요청 사건은 Chromium만 된다');
  for (const path of [queuePath, '/my/tickets/tkt-bat170-not-in-fixture']) {
    const { copied, opened } = await guideAddresses(browser, path);
    expect(copied, path).toEqual([`${WEB}${path}`]);
    expect(opened, path).toEqual([`${WEB}${path}`]);
    for (const v of [...copied, ...opened]) expect(v.includes('evt-lumen-1025'), `${path} 데모 공연으로 바뀌었다: ${v}`).toBe(false);
  }
});
