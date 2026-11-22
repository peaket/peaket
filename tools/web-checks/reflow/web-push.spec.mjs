// 웹 푸시 구독이 로그아웃과 월렛 정리를 넘어 남는지 실제 브라우저(Chromium)에서 본다(docs/frontend.md §6 FE-T43·§5.4·§5.14.4, ADR-0363 결정 6·7·8,
// BUILD_ORDER GAT-040, F-05-1). 운영 빌드의 소비자 웹(셸의 계정 메뉴 → 로그아웃 대화상자 → '이 기기의 입장 키도 지우기')을 실제로 누른다.
// - 진짜인 것: 웹 푸시 워커(/push/sw.js)·월렛 워커(/my/tickets/sw.js) 등록, Cache Storage, IndexedDB, 셸의 정리 루틴, 킬 스위치 워커(실행 값 kill로 띄운 서버).
// - 바깥 서비스 대역: 브라우저의 푸시 서비스(PushManager.subscribe·getSubscription만 addInitScript로 고정 구독을 돌려주게 바꾼다, 계획 §6),
//   팬 API(api.peaket.example: 팬 계정 요약은 가짜 API의 계약 모양을 그대로 넘기고, 웹 푸시 등록·해제는 차례만 기록한다),
//   앱 서버 로그아웃 POST /logout(identity가 없어 차례만 기록하고 303). 서버 쪽 차례·삭제는 core-svc 연결 시험(web-push-wiring.int.test.ts)이 실제 서버로 본다.
import { test, expect } from '@playwright/test';
import { APPS, HOST, MOCK_API_ORIGIN, portOf } from '../seed-css/apps.mjs';
import { FAN_API_ORIGIN } from '../csp/pages.mjs';

const WEB = `http://${HOST}:${portOf(APPS.find((a) => a.name === 'web'), 'prod')}`;
const WEB_KILL = `http://${HOST}:${Number(process.env.PEAKET_WEB_KILL_PORT ?? 4181)}`;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/f051-fe-t43';

test.use({ serviceWorkers: 'allow' });
test.beforeEach(({ browserName }) => {
  // skip-until: 2027-06-30 헤드리스 WebKit·Firefox는 알림 권한 부여(grantPermissions notifications)와 PushManager를 주지 않는다(F-05-1 FE-T43)
  test.skip(browserName !== 'chromium', '알림 권한·PushManager는 Chromium 헤드리스만 된다');
});

/** 푸시 서비스 대역: 고정 구독. unsubscribe를 부르면 창 전역에 센다(정리 루틴은 브라우저 구독을 풀지 않는다) */
async function fixedPushService(context) {
  await context.addInitScript((endpoint) => {
    if (typeof PushManager === 'undefined') return;
    const KEY = '__f051_push_sub';
    const sub = () => ({
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true },
      getKey: () => null,
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BOr3ZzkkqmFF0pp1ZRb2ZQn6wIXgVYtzFEGr3k4y8hTtjD0mBXrbT4w8yE0zLY-0j0xfnM8gRNbYTbG7qwPZb9A', auth: 'f051authf051auth' } }),
      unsubscribe: async () => {
        localStorage.setItem('__f051_unsubscribed', String(Number(localStorage.getItem('__f051_unsubscribed') ?? '0') + 1));
        return true;
      },
    });
    PushManager.prototype.subscribe = async function () {
      localStorage.setItem(KEY, '1');
      return sub();
    };
    PushManager.prototype.getSubscription = async function () {
      return localStorage.getItem(KEY) === '1' ? sub() : null;
    };
  }, ENDPOINT);
}

/** 팬 API 대역: 계정 요약은 가짜 API 그대로, 웹 푸시 등록·해제는 기록, 그 밖은 503. log에 나간 차례를 남긴다 */
async function fanApi(context, origin, log) {
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
  await context.route(`${FAN_API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '' } });
    }
    if (path === '/v1/identity/me') {
      const res = await fetch(`${MOCK_API_ORIGIN}${path}`);
      return route.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' }, body: Buffer.from(await res.arrayBuffer()) });
    }
    if (path.startsWith('/v1/push-subscriptions')) {
      log.push(`${req.method()} ${path}`);
      return req.method() === 'DELETE'
        ? route.fulfill({ status: 204, headers: cors })
        : route.fulfill({ status: 201, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ subscriptionKey: 'k'.repeat(43) }) });
    }
    return route.fulfill({ status: 503, headers: { ...cors, 'content-type': 'application/problem+json', 'cache-control': 'no-store' }, body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503 }) });
  });
}

const registrations = (page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort());

/** 이 브라우저에 웹 푸시 워커를 등록하고 구독한다(화면의 [알림 켜기] 흐름은 web-push/flow.test.mjs가 본다) */
async function subscribePush(page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/push/sw.js', { scope: '/push/' });
    await reg.pushManager.subscribe({ userVisibleOnly: true });
  });
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/push/'))?.active?.state ?? null), { timeout: 15_000 }).toBe('activated');
}

test('FE-T43 기본 폭: 로그아웃(입장 키 지우기)과 킬 스위치 뒤 /push/ 등록과 구독이 남고 DELETE가 POST /logout보다 먼저다', async ({ page, context }) => {
  await context.grantPermissions(['notifications'], { origin: WEB });
  await fixedPushService(context);
  const log = [];
  await fanApi(context, WEB, log);
  await context.route(`${WEB}/logout`, (route) => {
    log.push(`${route.request().method()} /logout`);
    return route.fulfill({ status: 303, headers: { location: '/', 'clear-site-data': '"cache"' } });
  });
  // 월렛 워커가 등록되고 활성이 될 때까지
  await page.goto(`${WEB}/my/tickets`);
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/my/tickets'))?.active?.state ?? null), { timeout: 30_000 }).toMatch(/^(activating|activated)$/);
  await subscribePush(page);
  await page.evaluate(async () => (await caches.open('wallet-shell-f051')).put('/f051-probe', new Response('x')));
  expect(await registrations(page)).toEqual(['/my/tickets', '/push/']);

  // 셸: 계정 메뉴 → 로그아웃 → 입장 키도 지우기 → 로그아웃
  await page.getByRole('button', { name: /^계정 메뉴/ }).click();
  await page.getByRole('menuitem', { name: '로그아웃' }).click();
  const dialog = page.getByRole('dialog', { name: '로그아웃합니다' });
  await dialog.getByRole('checkbox', { name: '이 기기의 입장 키도 지우기' }).check();
  await dialog.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page).toHaveURL(`${WEB}/`);

  // 서버 쪽 구독 해제가 로그아웃 요청보다 먼저
  expect(log.filter((l) => l.startsWith('DELETE ') || l === 'POST /logout')).toEqual([expect.stringMatching(/^DELETE \/v1\/push-subscriptions\/[A-Za-z0-9_-]{43}$/), 'POST /logout']);
  // 웹 푸시 워커 등록과 브라우저 구독은 남고 월렛 워커만 풀렸다. 월렛 캐시도 지웠다
  expect(await registrations(page)).toEqual(['/push/']);
  expect(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('/push/'))?.pushManager.getSubscription())?.endpoint ?? null)).toBe(ENDPOINT);
  expect(await page.evaluate(() => localStorage.getItem('__f051_unsubscribed'))).toBeNull();
  expect((await page.evaluate(() => caches.keys())).filter((n) => n.startsWith('wallet-shell-'))).toEqual([]);
});

test('FE-T43 기본 폭: 월렛 킬 스위치는 /push/ 등록과 브라우저 구독을 남긴다', async ({ page, context }) => {
  await context.grantPermissions(['notifications'], { origin: WEB_KILL });
  await fixedPushService(context);
  await fanApi(context, WEB_KILL, []);
  await page.goto(`${WEB_KILL}/`);
  await subscribePush(page);
  await page.goto(`${WEB_KILL}/my/tickets`);
  await expect.poll(() => registrations(page), { timeout: 30_000, message: '킬 스위치 뒤 등록' }).toEqual(['/push/']);
  expect(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('/push/'))?.pushManager.getSubscription())?.endpoint ?? null)).toBe(ENDPOINT);
  expect(await page.evaluate(() => localStorage.getItem('__f051_unsubscribed'))).toBeNull();
});
