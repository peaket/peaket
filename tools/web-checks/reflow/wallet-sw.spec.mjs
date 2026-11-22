// 월렛 서비스 워커의 캐시 거르기와 갱신 보류를 실제 브라우저(Chromium)에서 본다(docs/frontend.md §5.4 '서비스 워커'·'갱신' ①⑤,
// docs/security/asvs/frontend.md 14.3.2, BUILD_ORDER HOT-390). 운영 빌드의 /my/tickets를 열어 워커가 화면을 제어하게 한 뒤:
// - 경로 거르기와 no-store 거르기를 따로 잡도록 응답을 둘로 나눈다: 허용 꼴(/my/tickets/{id})인데 no-store인 응답, 캐시해도 되는 헤더인데 양도 경로인 응답.
//   허용 꼴이고 캐시해도 되는 응답은 캐시에 들어가야 한다(빈 결과가 통과로 새지 않게).
// - 바뀐 워커 스크립트를 내면 새 워커는 waiting에 머문다. SKIP_WAITING 메시지를 보내야 활성화된다.
// Playwright는 Chromium에서만 서비스 워커의 네트워크 요청을 context.route로 가로챈다.
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 실행은 웨이브 끝 무거운 게이트(계획 §7).
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';
import { stubFanApi } from '../csp/pages.mjs';

const WEB = `http://${HOST}:${portOf(APPS.find((a) => a.name === 'web'), 'prod')}`;
/** 월렛 워커 범위와 주소(docs/frontend.md §5.4 범위 세부, ADR-0363 결정 5) */
const SCOPE = '/my/tickets';
const SW_URL = '/my/tickets/sw.js';

/** 서비스 워커 요청 가로채기(context.route)가 Chromium에서만 되는 시험(HOT-390 둘) */
const chromiumOnly = (browserName) => {
  // skip-until: 2027-06-30 Playwright가 WebKit·Firefox 서비스 워커 요청을 context.route로 가로채지 못한다(HOT-390, F-05-1에서 범위 시험은 세 엔진으로 뺐다)
  test.skip(browserName !== 'chromium', '서비스 워커 요청 가로채기는 Chromium만 된다');
};

test.use({ serviceWorkers: 'allow' });

/** 워커 등록·제어 상태(실패 메시지에 싣는다) */
const swState = (page) =>
  page.evaluate(async (scope) => {
    const r = await navigator.serviceWorker.getRegistration(scope);
    return { url: location.pathname, controller: navigator.serviceWorker.controller?.scriptURL ?? null, scope: r?.scope ?? null, active: r?.active?.state ?? null, waiting: r?.waiting?.state ?? null, installing: r?.installing?.state ?? null };
  }, SCOPE);

/**
 * /my/tickets를 열고 월렛 워커가 이 화면을 제어할 때까지 기다린다.
 * 팬 API 대역은 페이지가 아니라 브라우저 문맥(context.route)에 단다(BAT-171 시험 이의 3: 첫 CI에서 page.route 아래 다시 불러온 문서에
 * 제어자가 생기지 않았다. 머리말대로 Chromium의 워커 요청은 context.route로 가로챈다). 다시 불러온 문서를 워커가 맡는지 보고,
 * 실패하면 등록·제어 상태를 메시지에 싣는다
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 */
async function controlled(page, context) {
  await stubFanApi(context);
  // 워커 스크립트가 운영 서버에서 나오는지 먼저 본다(BAT-171 시험 이의 6: 3차 CI에서 standalone 서버가 워커를 다시 묶으려다
  // app/sw.ts를 찾지 못해 실패했고, 등록이 한 번도 생기지 않았다). 실패하면 등록 기다림 대신 이 메시지로 끝난다.
  // 워커 주소는 /my/tickets/sw.js다(ADR-0363 결정 5, F-05-1 시험 이의: 옛 /serwist/sw.js는 없앴다)
  const sw = await page.request.get(`${WEB}${SW_URL}`);
  expect(sw.status(), `${SW_URL} 응답 ${sw.status()} ${(await sw.text()).slice(0, 200)}`).toBe(200);
  expect(sw.headers()['content-type'] ?? '', `${SW_URL}가 스크립트가 아니다`).toMatch(/javascript/);
  expect(sw.headers()['service-worker-allowed'], `${SW_URL}에 Service-Worker-Allowed: /my/tickets가 없다`).toBe(SCOPE);
  expect(sw.headers()['cache-control'], `${SW_URL}는 캐시하지 않는다(no-cache)`).toBe('no-cache');
  await page.goto(`${WEB}${SCOPE}`, { waitUntil: 'networkidle' });
  // 등록이 활성(activating·activated)이 될 때까지 기다린다. page.waitForFunction은 비동기 판정 함수가 돌려준 Promise를 참으로 읽어
  // 기다리지 않는다(BAT-171 시험 이의 5, 2차 CI에서 바로 뒤 상태가 scope·active 모두 null). 월렛 화면은 오프라인 배너 뒤 Serwist 덩어리를 받아 늦게 등록한다
  await expect
    .poll(() => swState(page), { timeout: 30_000, message: '월렛 워커 등록이 활성이 되지 않았다(등록 없음·설치 실패)' })
    .toEqual(expect.objectContaining({ scope: `${WEB}${SCOPE}`, active: expect.stringMatching(/^(activating|activated)$/) }));
  // 다시 불러오기 전 상태(판정하지 않고 실패 메시지에만 싣는다: 다시 불러온 문서만 워커를 비켜 갔는지 가른다)
  const before = await swState(page);
  await page.reload({ waitUntil: 'networkidle' });
  // 실패하면 받은 값(등록·제어 상태)이 함께 찍힌다
  await expect
    .poll(() => swState(page), { timeout: 10_000, message: `다시 불러온 문서를 월렛 워커가 맡지 않았다(다시 불러오기 전 ${JSON.stringify(before)})` })
    .toEqual(expect.objectContaining({ url: SCOPE, controller: expect.stringContaining(SW_URL) }));
}

const html = (title) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`;

/** 모든 Cache Storage 항목의 경로 */
const cachedPaths = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push({ cache: name, path: new URL(req.url).pathname });
    }
    return out;
  });

test('[ASVS v5.0.0-14.3.2] 기본 폭: 월렛 워커 아래서 연 양도 화면과 no-store 응답은 Cache Storage에 없다', async ({ page, context, browserName }) => {
  chromiumOnly(browserName);
  // 허용 꼴 + no-store → no-store 거르기만 막는다
  await context.route('**/my/tickets/tkt-bat170-nostore', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'private, no-store' }, body: html('no-store 티켓') }));
  // 양도 경로 + 캐시해도 되는 헤더 → 경로 거르기만 막는다
  await context.route('**/my/tickets/tkt-bat170-ok/transfer', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'public, max-age=60' }, body: html('양도') }));
  // 허용 꼴 + 캐시해도 되는 헤더 → 캐시에 들어가야 한다(대조군)
  await context.route('**/my/tickets/tkt-bat170-ok', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'public, max-age=60' }, body: html('티켓') }));
  await controlled(page, context);
  // 이동 미리 받기(navigationPreload)는 브라우저가 직접 내는 요청이라 시험 대역(context.route)을 지나 진짜 서버로 간다(BAT-171 시험 이의 8:
  // 고정 자료 밖 티켓이라 404). 이 시험 동안 끈다. 워커의 캐시 거르기(경로·no-store)는 워커의 fetch 응답에 그대로 걸린다(docs/frontend.md §5.4 '갱신' ⑤)
  const preload = await page.evaluate(async (scope) => {
    const r = await navigator.serviceWorker.getRegistration(scope);
    await r?.navigationPreload?.disable();
    return (await r?.navigationPreload?.getState())?.enabled ?? null;
  }, SCOPE);
  expect(preload, '이동 미리 받기를 끄지 못했다').toBe(false);

  for (const p of ['/my/tickets/tkt-bat170-ok', '/my/tickets/tkt-bat170-nostore', '/my/tickets/tkt-bat170-ok/transfer']) {
    const res = await page.goto(`${WEB}${p}`, { waitUntil: 'networkidle' });
    expect(res?.status(), p).toBe(200);
  }
  // 대조군이 캐시에 들어갈 때까지 기다린다(StaleWhileRevalidate는 응답 뒤에 넣는다)
  await expect.poll(async () => (await cachedPaths(page)).some((x) => x.path === '/my/tickets/tkt-bat170-ok'), { timeout: 10_000, message: '허용 꼴 응답이 캐시에 들지 않았다(빈 결과)' }).toBe(true);
  const all = await cachedPaths(page);
  expect(all.filter((x) => x.path === '/my/tickets/tkt-bat170-nostore'), 'no-store 응답이 캐시에 들었다').toEqual([]);
  expect(all.filter((x) => x.path.includes('/transfer')), '양도 화면이 캐시에 들었다').toEqual([]);
  expect(all.filter((x) => x.path.startsWith('/v1/')), 'API 응답이 캐시에 들었다').toEqual([]);
});

test('HOT-390 기본 폭: 새 워커는 waiting에 머물고 스스로 활성화하지 않는다', async ({ page, context, browserName }) => {
  chromiumOnly(browserName);
  await controlled(page, context);
  // 새 판을 낸다(새 배포와 같다). 워커 스크립트 갱신 요청(registration.update())은 브라우저가 직접 내 시험 대역에 걸리지 않으므로(BAT-171 시험 이의 8,
  // 4차 CI에서 같은 바이트를 받아 새 워커가 생기지 않았다) 같은 범위에 스크립트 주소만 다른 등록을 한다. 주소가 다르면 바이트가 같아도 새 워커를 설치한다
  // (서비스 워커 갱신 규칙). 경로 처리기는 쿼리를 보지 않고 같은 파일을 낸다
  await page.evaluate(async (scope) => {
    window.__controllerChanged = 0;
    navigator.serviceWorker.addEventListener('controllerchange', () => (window.__controllerChanged += 1));
    await navigator.serviceWorker.register('/my/tickets/sw.js?v=bat171-2', { scope, type: 'module' });
  }, SCOPE);
  // 비동기 판정이라 waitForFunction 대신 poll로 기다린다(위 controlled와 같은 까닭)
  await expect.poll(async () => (await swState(page)).waiting, { timeout: 15_000, message: '새 판 워커가 waiting에 들지 않았다' }).toBe('installed');
  expect(await page.evaluate(async (scope) => (await navigator.serviceWorker.getRegistration(scope)).waiting?.scriptURL ?? '', SCOPE), 'waiting 워커가 새 판이 아니다').toContain('v=bat171-2');
  // 화면이 열린 채로 기다려도 활성화하지 않는다
  await page.waitForTimeout(3_000);
  expect(await page.evaluate(async (scope) => !!(await navigator.serviceWorker.getRegistration(scope))?.waiting, SCOPE), '새 워커가 waiting을 떠났다').toBe(true);
  expect(await page.evaluate(() => window.__controllerChanged), '스스로 제어를 넘겼다').toBe(0);

  // BAT-170 검증 뒤 시험 V170-31(d02b8d19): SKIP_WAITING이 아닌 메시지(다른 type, 문자열, 빈 객체)는 활성화를 부르지 않는다(docs/frontend.md §5.4 '갱신' ①)
  await page.evaluate(async (scope) => {
    const w = (await navigator.serviceWorker.getRegistration(scope)).waiting;
    for (const m of [{ type: 'PING' }, 'SKIP_WAITING', { type: 'skip_waiting' }, {}, { kind: 'SKIP_WAITING' }]) w.postMessage(m);
  }, SCOPE);
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(async (scope) => !!(await navigator.serviceWorker.getRegistration(scope))?.waiting, SCOPE), 'V170-31 다른 메시지로 waiting을 떠났다').toBe(true);
  expect(await page.evaluate(() => window.__controllerChanged), 'V170-31 다른 메시지로 제어를 넘겼다').toBe(0);

  // 창이 SKIP_WAITING을 보내면 활성화되고 제어가 넘어간다
  await page.evaluate(async (scope) => (await navigator.serviceWorker.getRegistration(scope)).waiting.postMessage({ type: 'SKIP_WAITING' }), SCOPE);
  await page.waitForFunction(() => window.__controllerChanged > 0, undefined, { timeout: 15_000 });
  expect(await page.evaluate(async (scope) => !!(await navigator.serviceWorker.getRegistration(scope))?.waiting, SCOPE)).toBe(false);
});

// ---------- F-05-1 FE-T14: 워커 위치·범위·범위 밖 가로채기 0·킬 스위치(세 엔진, docs/frontend.md §6 FE-T14·§5.4, ADR-0363 결정 5·6, ASVS 3.5.4) ----------
// 범위 밖 화면(대기실·공연 상세·설정)을 같은 문맥에서 열었을 때 그 문서를 맡은 워커(controller)가 없고 월렛 등록의 범위가 /my/tickets 하나인지 본다.
// 요청 가로채기(context.route)로 워커 요청을 바꾸지 않으므로 세 엔진에서 돈다. 팬 API만 csp/pages.mjs 대역(503)으로 막는다.
// 비행기 모드 QR(O-T13)은 브라우저 확인(docs/review/browser-check) 몫으로 둔다(이 파일에는 O-T13 시험이 없다).

/** 범위 밖 경로(정본 FE-T14: 대기실·좌석·결제를 가로채지 않는다, ADR-0079 결정 18). 운영 빌드가 200으로 내는 대표 화면 */
const OUTSIDE = ['/queue/evt-lumen-1025/verify', '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01', '/my/settings', '/'];

/** 월렛을 열어 등록이 활성이 될 때까지 기다린다(요청 가로채기 없이) */
async function walletActive(page, context, origin = WEB) {
  await stubFanApi(context);
  await page.goto(`${origin}${SCOPE}`);
  await expect
    .poll(() => swState(page), { timeout: 30_000, message: '월렛 워커 등록이 활성이 되지 않았다' })
    .toEqual(expect.objectContaining({ scope: `${origin}${SCOPE}`, active: expect.stringMatching(/^(activating|activated)$/) }));
}

test('FE-T14 기본 폭: 워커는 /my/tickets/sw.js·범위 /my/tickets이고 /queue·/events·/my/settings 요청을 가로채지 않는다 [ASVS v5.0.0-3.5.4]', async ({ page, context }) => {
  await walletActive(page, context);
  const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: (r.active ?? r.waiting ?? r.installing)?.scriptURL ?? null })));
  expect(regs).toEqual([{ scope: `${WEB}${SCOPE}`, script: `${WEB}${SW_URL}` }]);
  // 월렛 목록 주소 자체(끝 / 없음)를 이 워커가 맡는다(ADR-0363 맥락 4)
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), { timeout: 10_000 }).toBe(`${WEB}${SW_URL}`);
  for (const p of OUTSIDE) {
    const res = await page.goto(`${WEB}${p}`);
    expect(res?.status(), p).toBe(200);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), `${p}를 워커가 맡았다`).toBeNull();
  }
});

/** 킬 스위치 모드(PEAKET_WALLET_SW_MODE=kill)로 띄운 같은 빌드의 웹 서버(playwright.reflow.config.mjs의 킬 스위치 서버) */
const WEB_KILL = `http://${HOST}:${Number(process.env.PEAKET_WEB_KILL_PORT ?? 4181)}`;

test('FE-T14 기본 폭: 킬 스위치 모드면 등록과 wallet-shell- 캐시가 지워지고 peaket-wallet은 남는다', async ({ page, context }) => {
  await stubFanApi(context);
  // 같은 주소 /my/tickets/sw.js가 킬 스위치 워커를 낸다(웹 앱 서버 실행 값, 빌드 값이 아니다)
  const kill = await page.request.get(`${WEB_KILL}${SW_URL}`);
  expect(kill.status()).toBe(200);
  expect(kill.headers()['service-worker-allowed']).toBe(SCOPE);
  const normal = await page.request.get(`${WEB}${SW_URL}`);
  expect(await kill.text(), '킬 스위치 모드인데 보통 워커와 같은 스크립트다').not.toBe(await normal.text());
  // 킬 스위치 앞의 상태: 월렛 캐시 둘·다른 캐시·입장 키 DB·웹 푸시 워커 등록
  await page.goto(`${WEB_KILL}/`);
  await page.evaluate(async () => {
    for (const name of ['wallet-shell-9', 'wallet-shell-10', 'f051-other-cache']) await (await caches.open(name)).put('/f051-probe', new Response('x'));
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('peaket-wallet');
      req.onsuccess = () => {
        req.result.close();
        resolve(undefined);
      };
      req.onerror = () => reject(req.error);
    });
    await navigator.serviceWorker.register('/push/sw.js', { scope: '/push/' });
  });
  // 월렛을 열면 킬 스위치 워커가 설치되자마자 활성화해 정리하고 자기 등록을 푼다
  await page.goto(`${WEB_KILL}${SCOPE}`);
  await expect
    .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort()), { timeout: 30_000, message: '킬 스위치 뒤 등록' })
    .toEqual(['/push/']);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).sort()), { timeout: 15_000 }).toEqual(['f051-other-cache']);
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).toContain('peaket-wallet');
});
