// FE-T40 시각 회귀: 대기실 경량 페이지 셸의 네 상태(waiting·soon·paused·stale) × 라이트·다크(docs/frontend.md §5.17).
// 셸은 데이터에 이었다(ADR-0207): `?state=` 대신 대기열·공연 공개 요약 호출을 가로채 실제 상태 기계로 네 상태를 만든다.
// 값은 퍼블리싱 기준 이미지와 같게 둔다(LUMEN, 앞 3,214명, 진행 62%, 약 2분). '곧 입장'만 계약 범위(retryAfterSeconds 1~5)의 5초다.
// 시계는 Playwright clock으로 고정·진행하고, 지터를 없애려고 Math.random을 고정한다. CSS 움직임은 멈춘 채 찍는다.
import { test, expect } from '@playwright/test';

const EVENT = 'evt-lumen-2026';
const FIXED_NOW = new Date('2026-11-04T10:00:00+09:00');
/** 운영 빌드의 기본 출처(apps/web/queue-room/src/config.ts ORIGINS) */
const QUEUE = 'https://queue.peaket.example';
const FILES = 'https://queue-files.peaket.example';
const API = 'https://api.peaket.example';
const TICKET = { queueTicket: 'qt.visual', seq: 11_935, generation: 1, segment: 11 };
const BITMAP = Buffer.alloc(125).toString('base64');
/** 앞 인원 = 11,935 − 8,700 − 1 − 20 = 3,214, 진행률 = (8,458 − 3,214) ÷ 8,458 = 62%, 예상 = 3,214 ÷ 26.8초 ≈ 2분 */
const FILE = { serving: 8_700, servingRate: 26.8, saleStatus: 'ON_SALE', removedUpToServing: 0, removedBeforeSegment: 20, removedBitmap: BITMAP, pollHintMs: 0 };
/** 쿠키를 싣는 진입·입장 확정은 출처를 그대로 돌려줘야 CORS를 지난다(파일은 쿠키가 없어 * 도 된다) */
const json = (route, status, body) => {
  const origin = route.request().headers().origin ?? '*';
  return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' }, body: JSON.stringify(body) });
};

/** state: 'waiting' | 'soon' | 'paused' | 'stale' */
async function open(page, state, theme) {
  await page.clock.install({ time: FIXED_NOW });
  await page.addInitScript(([key, rec]) => {
    Math.random = () => 0;
    localStorage.setItem(key, JSON.stringify({ ...rec, savedAt: Date.now() }));
    sessionStorage.setItem(`${key}.firstAhead`, '8458');
  }, [`peaket.queue.${EVENT}`, { preverifyToken: 'pv', ticket: TICKET }]);
  let failing = false;
  await page.route(`${API}/v1/events/**`, (r) => json(r, 200, { title: 'LUMEN 콘서트 2026 서울', startsAt: '2026-10-25T09:00:00Z', placeName: '피켓 아레나', queueOrder: 'HYBRID', seatAssignment: 'PICK', rounds: [] }));
  await page.route(`${FILES}/v1/queues/**`, (r) => {
    if (failing) return json(r, 500, {});
    const turn = state === 'soon';
    return json(r, 200, { ...FILE, serving: turn ? 12_000 : FILE.serving, saleStatus: state === 'paused' ? 'PAUSED' : 'ON_SALE', servingRate: state === 'paused' ? 0 : FILE.servingRate, generatedAtMs: Math.floor(Date.now() / 1000) * 1000 });
  });
  await page.route(`${QUEUE}/v1/queues/**`, (r) => json(r, 200, { status: 'SOON', retryAfterSeconds: 5 }));
  const q = theme === 'dark' ? '?theme=dark' : '';
  await page.goto(`/queue/${EVENT}${q}`);
  await expect(page.locator('.q-boot')).toHaveCount(0);
  if (state === 'soon') await expect(page.getByText('곧 입장합니다')).toBeVisible();
  else await expect(page.getByText('3,214명')).toBeVisible();
  await expect(page.getByText('LUMEN 콘서트 2026 서울')).toBeVisible();
  if (state === 'stale') {
    // 연속 3회 실패하면 '연결 확인 중'(마지막 값은 흐리게 둔다). 실패 뒤 간격이 늘어 시계를 앞으로 돌린다
    failing = true;
    for (let i = 0; i < 6 && !(await page.getByText('연결 확인 중').isVisible()); i++) {
      await page.clock.runFor(30_000);
      await page.waitForTimeout(50);
    }
    await expect(page.getByText('연결 확인 중')).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of ['light', 'dark']) {
  for (const id of ['waiting', 'soon', 'paused', 'stale']) {
    test(`FE-T40 대기실 셸 ${id} ${theme}: 기준 이미지와 픽셀 차이 0.1% 이하`, async ({ page }) => {
      await open(page, id, theme);
      await expect(page).toHaveScreenshot(`queue-room-${id}-${theme}.png`, { fullPage: true });
    });
  }
}
