// GAT-260 SCR-054 실서버 모드 브라우저 확인(2026-11-25). 실제 빌드한 소비자 웹(localhost:3000)과
// 가짜 API(127.0.0.1:4010)를 띄운 뒤 이 스크립트를 tools/web-checks에서 실행한다.
//   node likes/gat260.mjs
// 확인: 목록 카드, 503 오류와 다시 시도, 오프라인 찜 해제의 peaket.wishQueue 저장·복구 전송, 빈 목록.
import { chromium } from '@playwright/test';

const WEB = process.env.GAT260_WEB ?? 'http://localhost:3000';
const API = process.env.GAT260_API ?? 'http://127.0.0.1:4010';
const LIKES = `${WEB}/my/likes`;

const api = (path, init = {}) => fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
const fail = (msg) => {
  throw new Error(msg);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

try {
  // 0) 초기 찜 3건을 확인한다
  const initial = await api('/v1/wishes');
  if (initial.status !== 200) fail(`가짜 API 찜 목록이 ${initial.status}다`);
  const initialItems = (await initial.json()).items ?? [];
  if (initialItems.length < 1) fail('가짜 API의 초기 찜이 없다');

  // 1) 목록: 실제 값 카드와 판매 상태 배지
  await page.goto(LIKES, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '관심 공연·알림 신청' }).waitFor();
  await page.locator('article.card').first().waitFor();
  const cardCount = await page.locator('article.card').count();
  if (cardCount !== initialItems.length) fail(`목록 카드가 ${cardCount}개다(기대 ${initialItems.length})`);
  const firstTitle = (await page.locator('article.card h2').first().innerText()).trim();
  if (!firstTitle) fail('첫 카드 제목이 비었다');
  if ((await page.getByText('관심 공연이 없습니다').count()) !== 0) fail('목록이 있는데 빈 문구가 보인다');
  console.log(`목록: 카드 ${cardCount}개, 첫 제목 "${firstTitle}"`);

  // 2) 오류: /v1/wishes 503 → 오류 문구와 [다시 시도], 되돌린 뒤 다시 시도하면 목록이 돌아온다
  await page.route(/\/v1\/wishes(\?|$)/, (route) =>
    route.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: '잠시 뒤 다시 시도해 주세요', status: 503 }) }),
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '찜한 공연을 불러오지 못했습니다' }).waitFor();
  const retry = page.getByRole('button', { name: '다시 시도' });
  if ((await retry.count()) !== 1) fail('오류 화면에 [다시 시도]가 하나가 아니다');
  await page.unroute(/\/v1\/wishes(\?|$)/);
  await retry.click();
  await page.locator('article.card').first().waitFor();
  console.log('오류: 503 문구와 [다시 시도] 뒤 목록 복구 확인');

  // 3) 오프라인 대기열: 연결을 끊고 첫 카드의 찜 해제 → peaket.wishQueue 저장·저장 대기 배지, 연결 복구 뒤 전송
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  const first = page.locator('article.card').first();
  const firstTitleOffline = (await first.locator('h2').innerText()).trim();
  await first.getByRole('button', { name: new RegExp(`${escapeRegExp(firstTitleOffline)} 찜 해제`) }).click();
  await page.getByText('인터넷 연결이 없습니다').waitFor();
  await page.getByText('저장 대기').first().waitFor();
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('peaket.wishQueue') ?? '[]'));
  if (!Array.isArray(queued) || queued.length !== 1 || queued[0]?.action !== 'DELETE') fail(`오프라인 대기열이 기대와 다르다: ${JSON.stringify(queued)}`);
  console.log(`오프라인: "${firstTitleOffline}" 찜 해제가 peaket.wishQueue에 DELETE 1건으로 남고 '저장 대기' 표시`);

  await context.setOffline(false);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('peaket.wishQueue') ?? '[]').length === 0, null, { timeout: 10_000 });
  await page.getByText('인터넷 연결이 없습니다').waitFor({ state: 'detached' });
  const after = await api('/v1/wishes');
  const afterItems = (await after.json()).items ?? [];
  if (afterItems.length !== initialItems.length - 1) fail(`연결 복구 뒤 서버 찜이 ${afterItems.length}건이다(기대 ${initialItems.length - 1})`);
  console.log('온라인 복구: 대기열이 비고 서버 찜이 1건 줄었다');

  // 4) 빈 목록: 남은 찜을 모두 지우고 새로 고친다
  for (const item of afterItems) await api(`/v1/productions/${item.productionId}/wish`, { method: 'DELETE' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '관심 공연이 없습니다' }).waitFor();
  if ((await page.locator('article.card').count()) !== 0) fail('빈 목록인데 카드가 있다');
  console.log('빈 목록: "관심 공연이 없습니다" 확인');

  const visibleProblems = problems.filter((p) => !/favicon|Failed to load resource: the server responded with a status of 503|net::ERR_INTERNET_DISCONNECTED/.test(p));
  if (visibleProblems.length > 0) fail(`콘솔 오류: ${visibleProblems.join(' | ')}`);
  console.log('콘솔: 확인한 흐름에서 기대 밖 오류 없음');
} finally {
  await browser.close();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
