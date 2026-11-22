// 입장용 휴대폰 등록 전 안내를 실제 브라우저에서 본다(docs/features/offline-gate.md §11 O-T50 ①·O-T32, ADR-0363 결정 10, BUILD_ORDER GAT-020, F-05-1).
// F-05-1 검증이 넘긴 것: 이름은 '등록 요청이 0건'인데 node 시험은 화면 원문의 차례만 봤다. 운영 빌드의 티켓 펼침에서 [이 휴대폰을 입장용으로 등록]을
// 실제로 누르고, 팬 API의 기기 키 등록 요청 수와 IndexedDB `peaket-wallet`의 키 수를 센다.
// - 바깥 대역: 팬 API(api.peaket.example). 기기 키 등록은 세기만 하고 503(다시 보내기)으로 답한다. 그 밖은 csp/pages.mjs와 같은 503
// - 사용자 에이전트만 iOS Safari 탭·데스크톱으로 바꾼다(엔진은 그대로). 판별 함수 자체는 apps/web wallet-device-key/platform.test.mjs가 본다
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';
import { FAN_API_ORIGIN } from '../csp/pages.mjs';

const WEB = `http://${HOST}:${portOf(APPS.find((a) => a.name === 'web'), 'prod')}`;
/** 가짜 고정 자료의 티켓 펼침 */
const TICKET = '/my/tickets/tkt-lumen-r1-0312';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';
const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/** 팬 API 대역. 기기 키 등록 요청을 센다 */
async function fanApi(context) {
  const calls = [];
  const cors = { 'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true', vary: 'Origin' };
  await context.route(`${FAN_API_ORIGIN}/**`, (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '' } });
    }
    if (/\/v1\/tickets\/[^/]+\/device-keys$/.test(new URL(req.url()).pathname)) calls.push(req.method());
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

/** 펼친 첫 티켓의 좌석(가짜 고정 자료). 버튼 이름 앞에 붙는다 */
const SEAT = 'R구역 12열 7번';

test.describe(() => {
  // iOS Safari 탭: 휴대폰 화면·터치(데스크톱 안내가 먼저 뜨지 않게). Firefox는 isMobile을 지원하지 않는다
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 393, height: 852 }, hasTouch: true });
  test('O-T50 ① 기본 폭: iOS Safari 탭은 키를 만들지 않고 등록 요청이 0건이다', async ({ page, context, browserName }) => {
    // skip-until: 2027-06-30 Playwright Firefox는 isMobile·터치 휴대폰 문맥을 주지 않는다(F-05-1 O-T50 ①)
    test.skip(browserName === 'firefox', 'Firefox는 휴대폰 문맥을 흉내 내지 못한다');
    const calls = await fanApi(context);
    expect((await page.goto(`${WEB}${TICKET}`))?.status()).toBe(200);
    // 실제 등록 부품(DeviceQr)의 버튼. 이름은 'QR 설명, 이 휴대폰을 입장용으로 등록'이다(보드 목업 GoButton과 가른다)
    await page.getByRole('button', { name: new RegExp(`^입장 QR, 티켓 [^,]+, ${SEAT},.*이 휴대폰을 입장용으로 등록$`) }).click();
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
    await expect(page.getByRole('heading', { name: '입장 QR은 휴대폰에서 등록하세요' })).toBeVisible();
    await expect(page.getByRole('button', { name: `${SEAT}, 그래도 이 기기에 등록` })).toBeVisible();
    // 화면이 다 붙을 때까지(지금 동기화 버튼) 기다린 뒤 센다: 열기만 해서는 등록 요청 0건, 이 기기에 키 0개
    await expect(page.getByRole('button', { name: '지금 동기화' })).toBeVisible();
    expect(calls).toEqual([]);
    expect(await storedKeys(page)).toBe(0);
  });
});
