// 입장용 휴대폰 등록 전 안내를 실제 브라우저에서 본다(docs/features/offline-gate.md §11 O-T50 ①·O-T32, ADR-0363 결정 10, BUILD_ORDER GAT-020, F-05-1).
// F-05-1 검증이 넘긴 것: 이름은 '등록 요청이 0건'인데 node 시험은 화면 원문의 차례만 봤다. 운영 빌드의 티켓 펼침에서 [이 휴대폰을 입장용으로 등록]을
// 실제로 누르고, 팬 API의 기기 키 등록 요청 수와 IndexedDB `peaket-wallet`의 키 수를 센다.
// - 바깥 대역: 팬 API(api.peaket.example). 실제 월렛(WalletLive)이 목록 `GET /v1/tickets`와 회차 요약 `GET /v1/events/{id}`로 카드를 그리므로
//   UUIDv7 티켓 한 장과 그 회차를 답한다(FIX-wallet-tickets, docs/frontend.md §4.2.4). 기기 키 등록은 세기만 하고 503(다시 보내기)으로 답한다.
//   그 밖은 csp/pages.mjs와 같은 503
// - 사용자 에이전트만 iOS Safari 탭·데스크톱으로 바꾼다(엔진은 그대로). 판별 함수 자체는 apps/web wallet-device-key/platform.test.mjs가 본다
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';
import { FAN_API_ORIGIN } from '../csp/pages.mjs';

const WEB = `http://${HOST}:${portOf(APPS.find((a) => a.name === 'web'), 'prod')}`;
const DAY = 24 * 3_600_000;
/** live 월렛이 목록에서 그리는 시험 티켓(UUIDv7: ticket-svc가 발권하는 꼴, offline-gate §3 페이로드 스키마) */
const TICKET_ID = '0193f2c0-0000-7000-8000-0000000fe301';
const EVENT_ID = '0193f2c0-0000-7000-8000-0000000fe201';
/** 실제 월렛 펼침 */
const TICKET = `/my/tickets/${TICKET_ID}`;
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/** 팬 API 대역. 목록·회차 요약으로 live 월렛 카드를 그리고, 기기 키 등록 요청을 센다 */
async function fanApi(context) {
  const calls = [];
  const cors = { 'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true', vary: 'Origin' };
  const startsAt = new Date(Date.now() + 7 * DAY).toISOString();
  const startsMs = Date.parse(startsAt);
  await context.route(`${FAN_API_ORIGIN}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '' } });
    }
    if (req.method() === 'GET' && path === '/v1/tickets') {
      return route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'private, no-store' },
        body: JSON.stringify({
          items: [{ ticketId: TICKET_ID, eventId: EVENT_ID, status: 'ISSUED', transferLocked: false, eventStartsAt: startsAt, cancelDeadline: startsAt, receivedFromNickname: null }],
          nextCursor: null,
        }),
      });
    }
    if (req.method() === 'GET' && path === `/v1/events/${EVENT_ID}`) {
      return route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
        body: JSON.stringify({
          eventId: EVENT_ID,
          title: 'LUMEN 콘서트 2026 서울',
          startsAt,
          sellerName: '주식회사 피켓 시험',
          placeName: '피켓 아레나',
          entryOpensAt: new Date(startsMs - 3_600_000).toISOString(),
          endsAt: new Date(startsMs + 3 * 3_600_000).toISOString(),
        }),
      });
    }
    if (/\/v1\/tickets\/[^/]+\/device-keys$/.test(path)) calls.push(req.method());
    return route.fulfill({ status: 503, headers: { ...cors, 'content-type': 'application/problem+json', 'cache-control': 'no-store' }, body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503 }) });
  });
  return calls;
}

/** 이 브라우저 IndexedDB peaket-wallet의 기기 키 수(DB나 표가 없으면 0) */
const storedKeys = (page) =>
  page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'peaket-wallet')) return 0;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('peaket-wallet');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('deviceKeys')) {
          db.close();
          return resolve(0);
        }
        const c = db.transaction('deviceKeys', 'readonly').objectStore('deviceKeys').count();
        c.onsuccess = () => {
          db.close();
          resolve(c.result);
        };
        c.onerror = () => reject(c.error);
      };
    });
  });

/** 실제 월렛 카드의 [이 휴대폰을 입장용으로 등록](대체 글은 QR 라벨 + 동작, features/wallet-sync/model.ts walletQrLabel) */
const registerButton = (page) => page.getByRole('button', { name: new RegExp(`^입장 QR, 티켓 ${TICKET_ID}, 15초마다 바뀝니다, 이 휴대폰을 입장용으로 등록$`) });

test.describe(() => {
  // iOS Safari 탭: 휴대폰 화면·터치(데스크톱 안내가 먼저 뜨지 않게). Firefox는 isMobile을 지원하지 않는다
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 393, height: 852 }, hasTouch: true });
  test('O-T50 ① 기본 폭: iOS Safari 탭은 키를 만들지 않고 등록 요청이 0건이다', async ({ page, context, browserName }) => {
    // skip-until: 2027-06-30 Playwright Firefox는 isMobile·터치 휴대폰 문맥을 주지 않는다(F-05-1 O-T50 ①)
    test.skip(browserName === 'firefox', 'Firefox는 휴대폰 문맥을 흉내 내지 못한다');
    const calls = await fanApi(context);
    expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
    // 실제 등록 부품(DeviceQr)의 버튼. 이름은 'QR 설명, 이 휴대폰을 입장용으로 등록'이다(보드 목업 GoButton과 가른다)
    await registerButton(page).click();
    await expect(page.getByRole('status').filter({ hasText: '홈 화면에 추가한 앱에서 등록하세요' })).toBeVisible();
    await expect(page.getByRole('button', { name: '방법 보기' })).toBeVisible();
    const goOn = page.getByRole('button', { name: '그래도 이 브라우저에 등록' });
    await expect(goOn).toBeVisible();
    // 안내만 보였다: 등록 요청 0건, 이 기기에 키 0개
    expect(calls).toEqual([]);
    expect(await storedKeys(page)).toBe(0);
    // 대조(빈 결과가 통과로 새지 않게): ( 그래도 이 브라우저에 등록 › )을 누르면 그때 키를 만든다(O-T50 ③). 요청 대역(context.route)은
    // Windows WebKit에서 교차 출처 POST를 받지 못해 연결 실패(등록 확인 전)로 끝나므로, 대조는 이 기기에 생긴 키 수로 본다
    await goOn.click();
    await expect.poll(() => storedKeys(page), { timeout: 15_000, message: '그래도 등록을 눌렀는데 키를 만들지 않았다' }).toBe(1);
  });
});

test.describe(() => {
  test.use({ userAgent: WINDOWS_CHROME });
  test('O-T32 기본 폭: 데스크톱으로 보이는 브라우저에서 월렛을 열면 키를 만들지 않고 휴대폰 등록을 안내한다(요청 0건)', async ({ page, context }) => {
    const calls = await fanApi(context);
    expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
    // 실제 월렛은 키가 없으면 먼저 [이 휴대폰을 입장용으로 등록]을 그린다. 누르면 키를 만들기 전에 데스크톱 안내가 뜬다(d5 §5.13)
    await registerButton(page).click();
    await expect(page.getByRole('status').filter({ hasText: '입장 QR은 휴대폰에서 등록하세요' })).toBeVisible();
    await expect(page.getByRole('button', { name: '그래도 이 기기에 등록' })).toBeVisible();
    // 화면이 다 붙을 때까지(지금 동기화 버튼) 기다린 뒤 센다: 안내만 보였으므로 등록 요청 0건, 이 기기에 키 0개
    await expect(page.getByRole('button', { name: '지금 동기화' })).toBeVisible();
    expect(calls).toEqual([]);
    expect(await storedKeys(page)).toBe(0);
  });
});

// F-05-1 구현 결함 2 재현(감독 지시, 2026-11-23): 데스크톱 안내의 ( 그래도 이 기기에 등록 › )을 누르면 실제로 등록한다.
// 정본: docs/features/offline-gate.md §2 '데스크톱 브라우저로 보이면 … 먼저 보인다 … 사용자가 원하면 데스크톱에서도 등록할 수 있다',
// docs/design/d5-screen-blueprint.md §5.13 '( 그래도 이 기기에 등록 › )', ADR-0363 결정 10('데스크톱 안내와 같은 꼴' — iOS 탭의 ( 그래도 이 브라우저에 등록 › )은 등록한다)
test.describe(() => {
  test.use({ userAgent: WINDOWS_CHROME });
  test('O-T32 기본 폭: 데스크톱 안내에서 ( 그래도 이 기기에 등록 › )을 누르면 이 기기에 키를 만들어 등록을 보낸다', async ({ page, context }) => {
    await fanApi(context);
    expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
    await expect(page.getByRole('button', { name: '지금 동기화' })).toBeVisible();
    expect(await storedKeys(page)).toBe(0);
    await registerButton(page).click();
    await page.getByRole('button', { name: '그래도 이 기기에 등록' }).click();
    // 이 기기에 키가 생긴다(등록 흐름은 키를 '확인 전'으로 먼저 저장한 뒤 보낸다, docs/frontend.md §4.2.4)
    await expect.poll(() => storedKeys(page), { timeout: 15_000, message: '그래도 이 기기에 등록을 눌렀는데 키를 만들지 않았다(토스트만)' }).toBe(1);
    // 등록 요청 수는 아래 시험이 본다(Windows WebKit은 요청 대역이 교차 출처 POST를 받지 못한다)
  });
});

test('O-T32 기본 폭: 데스크톱 ( 그래도 이 기기에 등록 › )은 기기 키 등록 POST를 한 번 보낸다', async ({ page, context, browserName }) => {
  // skip-until: 2027-06-30 Windows WebKit은 context.route가 교차 출처 POST를 받지 못한다(F-05-1). 키 생성은 위 시험이 세 엔진에서 본다
  test.skip(browserName === 'webkit', '요청 대역이 WebKit의 교차 출처 POST를 받지 못한다');
  const calls = await fanApi(context);
  expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
  await expect(page.getByRole('button', { name: '지금 동기화' })).toBeVisible();
  await registerButton(page).click();
  await page.getByRole('button', { name: '그래도 이 기기에 등록' }).click();
  await expect.poll(() => calls, { timeout: 15_000, message: '그래도 이 기기에 등록을 눌렀는데 등록 요청이 없다' }).toEqual(['POST']);
});

// 정본 O-T50 ③ '등록하고 persist()를 한 번 부른다'(docs/frontend.md §5.4 '등록할 때 persist()를 요청'). 결과를 기다리라는 말은 없고,
// Firefox는 persist()가 사용자 답까지 끝나지 않는다(F-05-1 시험 이의, 커밋 ac64c6780). 브라우저의 persist()를 끝나지 않는 약속으로 바꿔(바깥 경계 대역)
// 누를 때 한 번 부르는지와, 그 답 없이도 등록이 끝나는지(이 기기에 키)를 본다
/** persist()를 세고 끝나지 않게 바꾼다(엔진마다 자리가 달라 프로토타입에 두고, 없으면 navigator.storage째 둔다) */
const hangingPersist = (context) =>
  context.addInitScript(() => {
    window.__f051PersistCalls = 0;
    const persist = () => ((window.__f051PersistCalls += 1), new Promise(() => {}));
    if (typeof StorageManager !== 'undefined') Object.defineProperty(StorageManager.prototype, 'persist', { configurable: true, value: persist });
    if (!navigator.storage?.persist) Object.defineProperty(navigator, 'storage', { configurable: true, value: { ...(navigator.storage ?? {}), persist } });
  });
const persistCalls = (page) => page.evaluate(() => window.__f051PersistCalls);

test.describe(() => {
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 393, height: 852 }, hasTouch: true });
  test('O-T50 ③ 기본 폭: ( 그래도 이 브라우저에 등록 › )을 누르면 persist()를 한 번 부르고 그 답을 기다리지 않고 키를 만든다', async ({ page, context, browserName }) => {
    // skip-until: 2027-06-30 Playwright Firefox는 휴대폰 문맥을 주지 않는다. Firefox의 '답 없는 persist'는 아래 데스크톱 시험이 본다(F-05-1)
    test.skip(browserName === 'firefox', 'Firefox는 휴대폰 문맥을 흉내 내지 못한다');
    await hangingPersist(context);
    await fanApi(context);
    expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
    await registerButton(page).click();
    const goOn = page.getByRole('button', { name: '그래도 이 브라우저에 등록' });
    await expect(goOn).toBeVisible();
    // 월렛을 열 때 부른 몫(O-T50 ⑤)은 이미 지났다. 누른 뒤의 몫만 센다
    const before = await persistCalls(page);
    expect(before, '월렛을 열 때 persist()를 부르지 않았다(O-T50 ⑤)').toBeGreaterThanOrEqual(1);
    await goOn.click();
    await expect.poll(() => storedKeys(page), { timeout: 15_000, message: 'persist()의 답을 기다리느라 등록이 끝나지 않았다' }).toBe(1);
    expect((await persistCalls(page)) - before).toBe(1);
  });
});

test.describe(() => {
  test.use({ userAgent: WINDOWS_CHROME });
  test('O-T50 ③ 기본 폭: persist()가 답하지 않아도(데스크톱 ( 그래도 이 기기에 등록 › )) 등록이 끝나 이 기기에 키가 생긴다', async ({ page, context }) => {
    await hangingPersist(context);
    await fanApi(context);
    expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
    await expect(page.getByRole('button', { name: '지금 동기화' })).toBeVisible();
    await registerButton(page).click();
    await page.getByRole('button', { name: '그래도 이 기기에 등록' }).click();
    await expect.poll(() => storedKeys(page), { timeout: 15_000, message: 'persist()의 답을 기다리느라 등록이 끝나지 않았다' }).toBe(1);
    expect(await persistCalls(page), '등록에서 persist()를 부르지 않았다').toBeGreaterThanOrEqual(1);
  });
});
