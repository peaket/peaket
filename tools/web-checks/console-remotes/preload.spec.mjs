// 미리 받기와 무결성(F-03-2 OPS-360 T10, FE-T17·FE-T25). Chromium(요청 우선순위를 개발 도구 프로토콜로 읽는다).
// 정본: ADR-0091 결정 1 '미리 받기'(대시보드를 처음 그린 뒤 2초 [가정]에 명령 화면 덩어리를 낮은 우선순위로, 그다음 다음 단계 탭의 원격을 미리 받는다,
// 무결성 확인을 거치지 않으면 원격은 미리 받지 않는다, 메뉴 항목에 포인터가 올라가면 그 화면 lazy를 미리 부른다), docs/frontend.md §5.7 '화면별 늦게 싣기',
// §6.3 '확인 필요'(미리 받기 PoC), ADR-0361 결정 5·6(미리 싣기는 같은 적재기, 이미 실패한 원격을 다시 받지 않는다).
// 2초 경계(1,999·2,000ms)는 단위 시험(src/shared/lib/preload.test.mjs)이 가짜 시계로 본다. 화면은 실제 시계로 아래 끝(타이머는 일찍 울리지 않는다)만 본다.
import { test, expect } from '@playwright/test';
import { countRequests, entryOf, flipOneByte, stage, trackRemoteScripts } from './forge.mjs';

const PRELOAD_MS = 2_000;
const CMD_CHUNK = /^\/assets\/scr-030\.[0-9a-f]+\.chunk\.js$/;

let s;
test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** 개발 도구 프로토콜로 요청의 처음 우선순위를 적는다(경로 → 우선순위) */
async function priorities(page) {
  const cdp = await page.context().newCDPSession(page);
  const seen = new Map();
  cdp.on('Network.requestWillBeSent', (e) => seen.set(new URL(e.request.url).pathname, e.request.initialPriority));
  await cdp.send('Network.enable');
  return seen;
}

test('F-03-2 T10 FE-T25 ① 대시보드를 그린 뒤 2초가 지나서야 명령 화면 덩어리를 낮은 우선순위로 받고, 메뉴에 포인터가 가면 그 화면 덩어리를 받는다', async ({ page }) => {
  s = await stage();
  const pr = await priorities(page);
  const req = countRequests(page, s.origin);
  const cmd = page.waitForResponse((r) => CMD_CHUNK.test(new URL(r.url()).pathname) && r.status() === 200);
  await page.goto(`${s.origin}/dashboard?tab=live`);
  await expect(page.locator('[data-remote="queue"]')).toHaveCount(1);
  expect(req.count(CMD_CHUNK), '첫 화면 묶음에 명령 화면 덩어리가 없다').toBe(0);
  await cmd;
  const startedAt = await page.evaluate((re) => performance.getEntriesByType('resource').find((e) => new RegExp(re).test(new URL(e.name).pathname))?.startTime, CMD_CHUNK.source);
  expect(startedAt, '문서 시작부터 2초 [가정]가 지나기 전에는 받지 않는다').toBeGreaterThanOrEqual(PRELOAD_MS);
  const [cmdPath] = [...pr.keys()].filter((p) => CMD_CHUNK.test(p));
  expect(pr.get(cmdPath), '낮은 우선순위').toBe('Low');
  // 메뉴 위 미리 부르기: 감사·리플레이(SCR-031) 덩어리는 누르기 전에 받는다
  const AUDIT = /^\/assets\/scr-031\.[0-9a-f]+\.chunk\.js$/;
  expect(req.count(AUDIT)).toBe(0);
  const audit = page.waitForResponse((r) => AUDIT.test(new URL(r.url()).pathname) && r.status() === 200);
  await page.getByRole('link', { name: '감사·리플레이' }).first().hover();
  await audit;
  expect(page.url(), '아직 화면을 옮기지 않았다').toContain('/dashboard');
});

test('F-03-2 T10 FE-T17 ② 다음 단계 탭의 원격 미리 싣기도 같은 무결성 적재기라 위조 원격은 실행되지 않고(낮은 우선순위로 두 번 시도) 실패를 한 번 센다', async ({ page }) => {
  s = await stage((dir, list) => void flipOneByte(dir, entryOf(list, 'queue')));
  const q = entryOf(s.list, 'queue');
  const p = entryOf(s.list, 'purchase');
  const tries = await trackRemoteScripts(page);
  const rum = [];
  page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/_t/rum' && rum.push(r.postDataJSON()));
  // 원격 자리가 없는 T-30분 점검 탭에서 2초 뒤 미리 싣기
  await page.goto(`${s.origin}/dashboard?tab=t30`);
  await expect(page.locator('[data-remote]')).toHaveCount(0);
  await expect.poll(() => tries.count(q.entry), { timeout: 4 * PRELOAD_MS }).toBe(2);
  await expect.poll(() => tries.count(p.entry)).toBe(1);
  expect((await tries.all()).map((x) => [x.path, x.fetchpriority, x.integrity]).sort()).toEqual(
    [
      [q.entry, 'low', q.integrity],
      [q.entry, 'low', q.integrity],
      [p.entry, 'low', p.integrity],
    ].sort(),
  );
  await expect.poll(() => page.evaluate(() => [typeof window.peaket_widget_queue, typeof window.peaket_widget_purchase])).toEqual(['undefined', 'object']);
  await expect.poll(() => rum.flatMap((b) => b.counters)).toEqual([{ name: 'remote_load_failed_total', labels: { remote: 'queue', reason: 'integrity' }, value: 1 }]);
});

test('F-03-2 T10 FE-T17 ③ 이미 실패한 원격을 2초 뒤 미리 싣기가 다시 받지 않고 실패 수를 다시 세지 않는다', async ({ page }) => {
  s = await stage((dir, list) => void flipOneByte(dir, entryOf(list, 'queue')));
  const q = entryOf(s.list, 'queue');
  const tries = await trackRemoteScripts(page);
  const rum = [];
  page.on('request', (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/_t/rum' && rum.push(r.postDataJSON()));
  const cmd = page.waitForResponse((r) => CMD_CHUNK.test(new URL(r.url()).pathname) && r.status() === 200);
  await page.goto(`${s.origin}/dashboard?tab=live`);
  await expect(page.getByRole('region', { name: '입장 비율·빈자리' }).filter({ hasText: '이 위젯만 불러오지 못했습니다' })).toHaveAttribute('data-remote-fail', 'integrity');
  expect(await tries.count(q.entry)).toBe(2);
  await expect.poll(() => rum.flatMap((b) => b.counters)).toEqual([{ name: 'remote_load_failed_total', labels: { remote: 'queue', reason: 'integrity' }, value: 1 }]);
  // 2초 뒤 미리 싣기가 돈다(명령 화면 덩어리 다음에 원격 미리 싣기를 부른다)
  await cmd;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  expect(await tries.count(q.entry), '미리 싣기는 실패한 원격을 다시 받지 않는다').toBe(2);
  expect((await tries.all()).filter((x) => x.fetchpriority === 'low'), '낮은 우선순위 시도가 없다(purchase는 이미 실었다)').toEqual([]);
});
