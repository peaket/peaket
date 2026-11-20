// 5만 석 좌석 화면 시나리오(S-T21·S-T31 ⑥, docs/features/seat-hold.md §12, BAT-182). Chromium 한 엔진, 이 PC, 로컬 realtime-gw 대역.
// 시험 페이지(seats/page/main.ts)가 제품과 같은 @peaket/seatmap Worker·엔진·연결을 쓰고, 서버(seats/server.mjs)가 구독·닫힘·스냅샷 요청을 기록한다.
import { test, expect } from '@playwright/test';

const EVENT = 'evt-50k';
/** 전체 보기 갱신 간격(정본 5,000ms) */
const SNAPSHOT_REFRESH_MS = 5_000;

const log = (request) => request.get('/__seats/log').then((r) => r.json());
const messages = (page) => page.evaluate(() => window.__seats.messages);
const metrics = (page) => page.evaluate(() => window.__seats.metrics);
const longTaskCount = (page) => page.evaluate(() => window.__seats.longTasks.length);
const send = (page, m) => page.evaluate((x) => window.__seats.send(x), m);
const lastSections = async (page) => (await messages(page)).filter((m) => m.type === 'sections').at(-1);

/** ready·live까지 기다린다 */
async function boot(page) {
  await page.goto('/');
  await expect.poll(async () => page.evaluate(() => Boolean(window.__seats?.messages.some((m) => m.type === 'ready'))), { message: '첫 그림(ready)', timeout: 30_000 }).toBe(true);
  await expect.poll(async () => page.evaluate(() => window.__seats.messages.filter((m) => m.type === 'connection').at(-1)?.state ?? null), { message: '좌석 스트림 live', timeout: 15_000 }).toBe('live');
}

/** 전체 시나리오를 한 번 돌고 기록을 모은다(각 시험이 자기 판정만 본다) */
async function scenario(page, request) {
  await request.get('/__seats/reset');
  await boot(page);
  const ready = (await messages(page)).find((m) => m.type === 'ready');
  expect(ready).toMatchObject({ seatCount: 50_000, sectionCount: 25 });

  // 전체 보기: 구독 0, SubscribeSections 없음, 구역 스냅샷 없음
  const overview = await log(request);
  expect(overview.stream.subscribed).toEqual([]);
  expect(overview.stream.maxSubscribed).toBe(0);
  expect(overview.snapshots.filter((s) => s.section !== null)).toEqual([]);
  expect(overview.snapshots.every((s) => s.admission)).toBe(true);
  expect(await lastSections(page)).toMatchObject({ visible: [], subscribed: [] });

  // 확대 A: 1,000ms 머문 뒤 그 구역 하나를 구독한다
  await send(page, { type: 'focusSection', section: 0 });
  await expect.poll(async () => (await lastSections(page))?.subscribed ?? null, { message: '0구역 구독', timeout: 10_000 }).toEqual([0]);
  await expect.poll(async () => (await log(request)).stream.subscribed.at(-1) ?? null, { message: '서버가 본 0구역 구독', timeout: 5_000 }).toEqual([0]);
  await expect.poll(async () => page.evaluate(() => window.__seats.messages.filter((m) => m.type === 'view').at(-1)?.level ?? null), { message: '좌석 단계', timeout: 5_000 }).toBe('seats');
  const afterA = await log(request);
  expect(afterA.stream.maxSubscribed).toBe(1);
  await expect.poll(async () => (await log(request)).snapshots.filter((s) => s.section === 0).length, { message: '0구역 스냅샷 한 번', timeout: 5_000 }).toBe(1);

  // 다른 분 선택 100번: 델타 종단 지연 p99(좌석 단계)
  await request.get('/__seats/delta?section=0&count=100&every=20');
  await expect.poll(async () => (await metrics(page)).length, { message: '델타 metrics 100개', timeout: 20_000 }).toBeGreaterThanOrEqual(100);
  const values = (await metrics(page)).slice(0, 100).sort((a, b) => a - b);
  const p99 = values[Math.ceil(values.length * 0.99) - 1];

  // 옆 구역 B로 끌어 이동: 사용자가 지도를 왼쪽으로 끈다(1.5초 동안 30번, 화면 -1,050px). 도중에 A가 화면 밖으로 나간다
  for (let i = 0; i < 30; i++) {
    await send(page, { type: 'pan', dx: -35, dy: 0 });
    await page.waitForTimeout(50);
  }
  await expect.poll(async () => (await lastSections(page))?.subscribed ?? null, { message: '1구역으로 이동', timeout: 10_000 }).toEqual([1]);
  await expect.poll(async () => (await log(request)).stream.subscribed.at(-1) ?? null, { message: '서버가 본 1구역 구독', timeout: 5_000 }).toEqual([1]);
  const afterB = await log(request);
  expect(afterB.stream.maxSubscribed).toBe(1);
  expect(afterB.stream.subscribed.at(-1)).not.toContain(0);
  await expect.poll(async () => (await log(request)).snapshots.filter((s) => s.section === 1).length, { message: '1구역 스냅샷 한 번', timeout: 5_000 }).toBe(1);

  // 전체 보기로 축소: 구독 0. 4,999ms에는 전체 스냅샷을 보내지 않고 5,000ms에 한 번 받는다
  const fitAt = Date.now();
  await send(page, { type: 'fit' });
  // 먼저 4,999ms 경계를 본다(구독 해제를 기다리며 시간을 먹지 않게 순서를 둔다)
  const elapsed = Date.now() - fitAt;
  if (elapsed < SNAPSHOT_REFRESH_MS - 1) await page.waitForTimeout(SNAPSHOT_REFRESH_MS - 1 - elapsed);
  const early = await log(request);
  expect(
    early.snapshots.filter((s) => s.section === null && s.at >= fitAt && s.at < fitAt + SNAPSHOT_REFRESH_MS - 1),
    '4,999ms 안의 전체 스냅샷',
  ).toHaveLength(0);
  await expect.poll(async () => (await lastSections(page))?.subscribed ?? null, { message: '전체 보기 구독 해제', timeout: 10_000 }).toEqual([]);
  await expect.poll(async () => (await log(request)).stream.subscribed.at(-1) ?? null, { message: '서버가 본 구독 해제', timeout: 5_000 }).toEqual([]);
  await expect
    .poll(async () => (await log(request)).snapshots.filter((s) => s.section === null && s.at >= fitAt).length, { message: '5,000ms 전체 스냅샷', timeout: 5_000 })
    .toBeGreaterThanOrEqual(1);

  const final = await log(request);
  const fullAfterFit = final.snapshots.filter((s) => s.section === null && s.at >= fitAt).sort((a, b) => a.at - b.at);
  const longTasks = await longTaskCount(page);
  console.info(
    `S-T21 측정: p99 ${p99}ms(표본 ${values.length}), Long Task ${longTasks}, 구독 ${JSON.stringify(final.stream.subscribed)}, 최대 ${final.stream.maxSubscribed}, 닫힘 ${final.stream.closed.length}, TimeSync ${final.stream.timeSyncs.length}, 스냅샷 전체 ${final.snapshots.filter((s) => s.section === null).length}·구역 ${JSON.stringify(final.snapshots.filter((s) => s.section !== null).map((s) => s.section))}, 구간 5초 뒤 전체 ${final.snapshots.filter((s) => s.section === null && s.at >= fitAt).length}`,
  );
  // 닫힘 0 확인을 위해 마지막에 화면을 떠난다(정상 1000). 그 뒤 연결이 정리된다
  await page.evaluate(() => window.__seats.dispose());
  await expect.poll(async () => (await log(request)).stream.connections, { message: 'dispose가 소켓을 닫는다', timeout: 5_000 }).toBe(0);
  const ended = await log(request);
  return {
    p99,
    p99Samples: values.length,
    longTasks,
    fullSnapshotsAfterFit: fullAfterFit.length,
    firstFullAfterFitMs: fullAfterFit.length > 0 ? fullAfterFit[0].at - fitAt : Number.POSITIVE_INFINITY,
    sectionSnapshots: final.snapshots.filter((s) => s.section !== null).map((s) => s.section),
    maxSubscribed: final.stream.maxSubscribed,
    subscribedLists: final.stream.subscribed,
    closes: final.stream.closed,
    timeSyncs: final.stream.timeSyncs,
    intervals: final.stream.intervals,
    connections: ended.stream.connections,
    connectionMessages: (await messages(page)).filter((m) => m.type === 'connection'),
    layoutRequests: final.layoutRequests,
  };
}

test.describe.configure({ mode: 'serial' });

test('S-T21 전체 보기 0구독·확대 1구독·옆 구역 이동·축소 해제를 5만 석에서 기록한다', async ({ page, request }) => {
  const r = await scenario(page, request);
  // 끌어 이동하는 동안 A를 빼고 B를 넣는 전체 집합이 1,000ms 간격으로 바뀐다. 한 번에 두 구역이 보이면 2까지다
  expect(r.maxSubscribed).toBeLessThanOrEqual(2);
  expect(r.subscribedLists[0]).toEqual([0]);
  expect(r.subscribedLists.some((l) => l.includes(1))).toBe(true);
  expect(r.subscribedLists.at(-1)).toEqual([]);
  // 구역 스냅샷은 새로 구독한 구역마다 한 번뿐이다(정상 경로 재요청 0)
  expect(r.sectionSnapshots).toEqual([0, 1]);
  expect(r.layoutRequests).toBe(1);
  expect(r.closes).toEqual([]);
});

test('S-T21 다른 분 선택이 화면에 p99 300ms 안에 그려지고 전체 보기는 5초에 갱신된다', async ({ page, request }) => {
  const r = await scenario(page, request);
  expect(r.p99Samples).toBe(100);
  expect(r.p99, `델타 p99 ${r.p99}ms`).toBeLessThanOrEqual(300);
  expect(r.fullSnapshotsAfterFit).toBeGreaterThanOrEqual(1);
  // 첫 전체 스냅샷은 fit 뒤 5,000ms 타이머에서 왔다(4,900ms보다 이르지 않다)
  expect(r.firstFullAfterFitMs).toBeGreaterThanOrEqual(4_900);
  // 확대·이동·축소 중 Long Task 0(§12 S-T21)
  expect(r.longTasks, 'Long Task').toBe(0);
});

test('S-T31 ⑥ 정상 화면 시나리오에서 최대 구독 16개 이하이고 닫힘이 0번이다', async ({ page, request }) => {
  const r = await scenario(page, request);
  expect(r.maxSubscribed).toBeLessThanOrEqual(16);
  // 4403·4429·1013·1009를 포함해 서버가 닫은 적이 없다
  expect(r.closes.map((c) => c.code).filter((code) => [4403, 4429, 1013, 1009].includes(code))).toEqual([]);
  expect(r.closes).toEqual([]);
  // TimeSync는 연결 직후 하나뿐이고 서로 1,000ms보다 멀다(초당 1 이하)
  expect(r.timeSyncs.length).toBeGreaterThanOrEqual(1);
  for (let i = 1; i < r.timeSyncs.length; i++) expect(r.timeSyncs[i].at - r.timeSyncs[i - 1].at).toBeGreaterThanOrEqual(1_000);
  // BatchInterval은 100을 유지하고 Degraded 배너가 서지 않는다
  expect(r.intervals.every((ms) => ms === 100)).toBe(true);
  expect(r.connectionMessages.some((m) => m.degraded === true)).toBe(false);
  expect(r.connectionMessages.at(-1)).toMatchObject({ state: 'live' });
  expect(r.connections).toBe(0);
});
