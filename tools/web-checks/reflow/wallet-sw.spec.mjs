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
const SCOPE = '/my/tickets';

test.use({ serviceWorkers: 'allow' });
test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', '서비스 워커 요청 가로채기는 Chromium만 된다');
});

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
  await page.goto(`${WEB}${SCOPE}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(async (scope) => !!(await navigator.serviceWorker.getRegistration(scope))?.active, SCOPE, { timeout: 30_000 });
  // 다시 불러오기 전 상태(판정하지 않고 실패 메시지에만 싣는다: 다시 불러온 문서만 워커를 비켜 갔는지 가른다)
  const before = await swState(page);
  await page.reload({ waitUntil: 'networkidle' });
  // 실패하면 받은 값(등록·제어 상태)이 함께 찍힌다
  await expect
    .poll(() => swState(page), { timeout: 10_000, message: `다시 불러온 문서를 월렛 워커가 맡지 않았다(다시 불러오기 전 ${JSON.stringify(before)})` })
    .toEqual(expect.objectContaining({ url: SCOPE, controller: expect.stringContaining('/serwist/sw.js') }));
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

test('[ASVS v5.0.0-14.3.2] 기본 폭: 월렛 워커 아래서 연 양도 화면과 no-store 응답은 Cache Storage에 없다', async ({ page, context }) => {
  // 허용 꼴 + no-store → no-store 거르기만 막는다
  await context.route('**/my/tickets/tkt-bat170-nostore', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'private, no-store' }, body: html('no-store 티켓') }));
  // 양도 경로 + 캐시해도 되는 헤더 → 경로 거르기만 막는다
  await context.route('**/my/tickets/tkt-bat170-ok/transfer', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'public, max-age=60' }, body: html('양도') }));
  // 허용 꼴 + 캐시해도 되는 헤더 → 캐시에 들어가야 한다(대조군)
  await context.route('**/my/tickets/tkt-bat170-ok', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'cache-control': 'public, max-age=60' }, body: html('티켓') }));
  await controlled(page, context);

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

test('HOT-390 기본 폭: 새 워커는 waiting에 머물고 스스로 활성화하지 않는다', async ({ page, context }) => {
  await controlled(page, context);
  const original = await (await page.request.get(`${WEB}/serwist/sw.js`)).text();
  expect(original.length, '워커 스크립트를 받지 못했다').toBeGreaterThan(0);
  // 바이트가 다른 새 판을 낸다(새 배포와 같다)
  await context.route('**/serwist/sw.js', (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', headers: { 'service-worker-allowed': SCOPE, 'cache-control': 'no-cache' }, body: `${original}\n// bat170-new-version\n` }),
  );
  await page.evaluate(async (scope) => {
    window.__controllerChanged = 0;
    navigator.serviceWorker.addEventListener('controllerchange', () => (window.__controllerChanged += 1));
    await (await navigator.serviceWorker.getRegistration(scope)).update();
  }, SCOPE);
  await page.waitForFunction(async (scope) => !!(await navigator.serviceWorker.getRegistration(scope))?.waiting, SCOPE, { timeout: 15_000 });
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
