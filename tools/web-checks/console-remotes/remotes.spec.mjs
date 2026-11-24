// 관제 원격 위젯을 무결성 적재기로 싣기(F-03-2 OPS-350 T1·T2·T3·T8·T18, FE-T17, ASVS 16.5.2). 세 엔진.
// 정본: docs/frontend.md §4.5 '싣는 순서'(목록 → 계약 판 확인(다르면 받지 않는다) → integrity·crossorigin 스크립트(시간 초과 5초 [가정]) → 한 번 다시 →
// 또 실패하면 그 칸만 대체 위젯(d5 §7.2 '이 위젯만 불러오지 못했습니다' [다시 시도]), [다시 시도]는 그 칸만 목록부터 다시 싣는다),
// §5.17 FE-T17(무결성 불일치·시간 초과·계약 판 불일치 → 그 칸만 대체 카드), asvs/frontend.md 16.5.2(외부 자원 실패 때 그 칸만 대체), ADR-0361 결정 1·2·5·7.
// 무대는 운영 빌드를 복사해 한 곳만 바꾼 관제 미리보기 서버다(forge.mjs). 위조 원격은 실제 원격 바이트의 한 바이트를 바꾼다.
// 무결성 확인은 '값을 읽었다'가 아니라 위조 바이트가 실행되지 않음(전역 컨테이너가 생기지 않음)을 바깥에서 본다.
// '한 번 다시'는 적재기가 진입 파일 스크립트 요소를 넣은 수로 센다(브라우저가 같은 주소를 캐시·진행 중 요청으로 채우면 네트워크 요청은 그보다 적다).
// page.goto는 domcontentloaded까지만 기다린다. 일부러 응답을 붙잡는 원격(T2)이나 실패한 원격이 load를 영원히 막아 CI WebKit에서 90초 타임아웃이 났다(45302978934).
// 화면 상태는 아래 단언이 기다리므로 load를 기다리지 않아도 된다.
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { countRequests, entryFile, entryOf, flipOneByte, stage, trackRemoteScripts, useAltQueue, writeList } from './forge.mjs';

const DASH = '/dashboard?tab=live';
const TITLE = { queue: '입장 비율·빈자리', purchase: '결제사' };
const CONTAINER = { queue: 'peaket_widget_queue', purchase: 'peaket_widget_purchase' };
/** 정본 값: 진입 파일 시간 초과 5초 [가정](§4.5) */
const TIMEOUT_MS = 5_000;

/** 원격 자리 하나: 실렸으면 [data-remote] 자리, 실패면 그 제목의 대체 카드 */
const loaded = (page, name) => page.locator(`[data-remote="${name}"]`);
const failCard = (page, name) => page.getByRole('region', { name: TITLE[name] }).filter({ hasText: '이 위젯만 불러오지 못했습니다' });
const containerKinds = (page) => page.evaluate((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof window[v]])), CONTAINER);

let s;
test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

test('F-03-2 T1 FE-T17 원격 바이트 한 바이트를 바꾸면 그 칸만 대체 카드(integrity)이고 진입 파일 요청은 정확히 2번, 위조 바이트는 실행되지 않으며 다른 원격·셸은 그대로다', async ({ page }) => {
  s = await stage((dir, list) => void flipOneByte(dir, entryOf(list, 'queue')));
  const q = entryOf(s.list, 'queue');
  const p = entryOf(s.list, 'purchase');
  const req = countRequests(page, s.origin);
  const tries = await trackRemoteScripts(page);
  await page.goto(s.origin + DASH, { waitUntil: 'domcontentloaded' });
  await expect(failCard(page, 'queue')).toBeVisible();
  await expect(failCard(page, 'queue')).toHaveAttribute('data-remote-fail', 'integrity');
  await expect(failCard(page, 'queue').getByRole('button', { name: '다시 시도' })).toBeVisible();
  // 다른 원격은 실렸다
  await expect(loaded(page, 'purchase')).toHaveCount(1);
  await expect(failCard(page, 'purchase')).toHaveCount(0);
  await expect(loaded(page, 'queue')).toHaveCount(0);
  expect(await tries.count(q.entry), '처음 + 한 번 다시').toBe(2);
  expect(await tries.count(p.entry)).toBe(1);
  expect(req.count(q.entry), '네트워크 요청은 한 번 이상 두 번 이하').toBeGreaterThanOrEqual(1);
  expect(req.count(q.entry)).toBeLessThanOrEqual(2);
  expect(req.count('/remotes.json')).toBe(1);
  expect(await containerKinds(page)).toEqual({ queue: 'undefined', purchase: 'object' });
  // 셸(메뉴)과 경보 패널은 그대로다
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '경보', exact: false }).first()).toBeVisible();
  // 시도마다 목록의 integrity와 crossorigin anonymous를 단다
  expect((await tries.all()).filter((x) => x.path === q.entry).map((x) => [x.integrity, x.crossorigin])).toEqual([
    [q.integrity, 'anonymous'],
    [q.integrity, 'anonymous'],
  ]);
});

test('F-03-2 T2 FE-T17 진입 파일이 5초 안에 오지 않으면 5초 뒤 한 번 다시 받고, 또 5초가 지나면 그 칸만 대체 카드(timeout)이며 더 받지 않는다', async ({ page }) => {
  s = await stage();
  const q = entryOf(s.list, 'queue');
  // 진입 파일 응답을 잡아 두기만 한다(오지 않는 원격). 우리 서버 API가 아니라 정적 원격 파일이다
  const held = [];
  await page.route(`**${q.entry}`, (route) => void held.push(route));
  // 경계(4,999·5,000ms)는 단위 시험(remote-loader.test.mjs T2)이 가짜 시계로 본다. 화면은 실제 시계로 한 번 보고, 타이머는 일찍 울리지 않으므로
  // 시도 사이 간격의 아래 끝만 단언한다(page.clock은 React Suspense 타이머까지 멈추거나 실제 시간과 섞여 간격이 흐트러진다)
  const tries = await trackRemoteScripts(page);
  const times = async () => (await tries.all()).filter((x) => x.path === q.entry).map((x) => x.t);
  await page.goto(s.origin + DASH, { waitUntil: 'domcontentloaded' });
  await expect(loaded(page, 'purchase')).toHaveCount(1);
  await expect.poll(() => tries.count(q.entry)).toBe(1);
  await expect(failCard(page, 'queue')).toHaveAttribute('data-remote-fail', 'timeout', { timeout: 4 * TIMEOUT_MS });
  const [t1, t2] = await times();
  expect(t2 - t1, '시간 초과 5초 [가정]를 기다린 뒤 다시').toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
  const failedAt = await page.evaluate(() => performance.now());
  expect(failedAt - t1, '두 번째도 5초를 기다린 뒤 대체 카드').toBeGreaterThanOrEqual(2 * TIMEOUT_MS - 20);
  expect(await tries.count(q.entry), '다시 받기는 한 번뿐').toBe(2);
  await expect(failCard(page, 'queue').getByRole('button', { name: '다시 시도' })).toBeVisible();
  expect(await containerKinds(page)).toEqual({ queue: 'undefined', purchase: 'object' });
  for (const r of held) await r.abort().catch(() => undefined);
});

test('F-03-2 T3 FE-T17 목록의 contractMajor가 호스트와 다르면 그 원격 진입 파일 요청이 0이고 그 칸만 대체 카드(contract)다', async ({ page }) => {
  s = await stage((dir, list) => {
    // 시험 값은 코드 상수와 다르게(판 2)
    entryOf(list, 'queue').contractMajor = 2;
    writeList(dir, list);
  });
  const q = entryOf(s.list, 'queue');
  const req = countRequests(page, s.origin);
  const tries = await trackRemoteScripts(page);
  await page.goto(s.origin + DASH, { waitUntil: 'domcontentloaded' });
  await expect(failCard(page, 'queue')).toHaveAttribute('data-remote-fail', 'contract');
  await expect(loaded(page, 'purchase')).toHaveCount(1);
  expect(await tries.count(q.entry), '판이 다르면 받지 않는다').toBe(0);
  expect(req.count(q.entry)).toBe(0);
  expect(req.count(/^\/remotes\/queue\//)).toBe(0);
});

test('F-03-2 T8 [ASVS v5.0.0-16.5.2] 원격 하나를 받지 못하면 그 칸만 대체 카드이고, [다시 시도]가 그 칸만 목록부터 다시 받아 성공하면 위젯을 그린다', async ({ page }) => {
  let restore;
  s = await stage((dir, list) => {
    const file = entryFile(dir, entryOf(list, 'purchase'));
    const bytes = readFileSync(file);
    rmSync(file);
    restore = () => writeFileSync(file, bytes);
  });
  const p = entryOf(s.list, 'purchase');
  const req = countRequests(page, s.origin);
  const tries = await trackRemoteScripts(page);
  await page.goto(s.origin + DASH, { waitUntil: 'domcontentloaded' });
  await expect(failCard(page, 'purchase')).toHaveAttribute('data-remote-fail', 'network');
  await expect(loaded(page, 'queue')).toHaveCount(1);
  await expect(failCard(page, 'queue')).toHaveCount(0);
  expect(await tries.count(p.entry), '처음 + 한 번 다시').toBe(2);
  const listBefore = req.count('/remotes.json');
  const queueBefore = await tries.count(entryOf(s.list, 'queue').entry);
  // 원격이 다시 올라온 뒤 [다시 시도]
  restore();
  await failCard(page, 'purchase').getByRole('button', { name: '다시 시도' }).click();
  await expect(loaded(page, 'purchase')).toHaveCount(1);
  await expect(failCard(page, 'purchase')).toHaveCount(0);
  expect(req.count('/remotes.json'), '[다시 시도]는 목록부터').toBe(listBefore + 1);
  expect(await tries.count(p.entry)).toBe(3);
  expect(await tries.count(entryOf(s.list, 'queue').entry), '다른 칸은 다시 받지 않는다').toBe(queueBefore);
  await expect(loaded(page, 'queue')).toHaveCount(1);
  expect(await containerKinds(page)).toEqual({ queue: 'object', purchase: 'object' });
});

test('F-03-2 T18 FE-T17 원격이 요구하는 계약 패키지 판(^2.0.0)이 호스트가 내놓은 판(1.x) 밖이면 그 원격만 대체 카드(contract)이고 다른 원격은 싣는다', async ({ page }) => {
  s = await stage((dir) => void useAltQueue(dir));
  const q = entryOf(s.list, 'queue');
  expect(q.sha).toBe('c0ffee000002');
  const tries = await trackRemoteScripts(page);
  await page.goto(s.origin + DASH, { waitUntil: 'domcontentloaded' });
  await expect(failCard(page, 'queue')).toHaveAttribute('data-remote-fail', 'contract');
  await expect(loaded(page, 'purchase')).toHaveCount(1);
  // 무결성은 맞아 진입 파일은 한 번 받아 실행하고(컨테이너는 생긴다), 판 불일치는 다시 받지 않는다
  expect(await tries.count(q.entry)).toBe(1);
  expect(await containerKinds(page)).toEqual({ queue: 'object', purchase: 'object' });
});
