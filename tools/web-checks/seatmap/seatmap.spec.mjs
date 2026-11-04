// K5 PoC: 5만 석 열 단위 좌석맵 파일을 Worker의 OffscreenCanvas로 풀고 그린다(BUILD_ORDER BAS-190, docs/frontend.md §5.2).
// 판정(chromium-k5만): §5.2 단계 3 'Worker 시작·캔버스 넘기기·파일 풀기 250ms'(격자 색인 포함), 단계 5 '전체 배치도 첫 그림 100ms',
// 메시지 비용 'p95 2ms', 좌석 화면 '메인 스레드 긴 작업 0'(§5.8). 다른 엔진은 reports/seatmap/<프로젝트>.json에 기록만 한다.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { judgeK5 } from './judge.mjs';

const toMB = (b) => (b === null ? null : +(b / 1048576).toFixed(2));
const BUDGET = { stage3Ms: 250, stage5Ms: 100, messageP95Ms: 2 };

/**
 * Worker 힙(GC 뒤 쓰는 크기, 바이트). Chromium만: 브라우저 세션에서 Worker 대상에 붙어(Target.attachToTarget, flatten 아님)
 * HeapProfiler.collectGarbage 뒤 Runtime.getHeapUsage를 부른다. Playwright의 newCDPSession은 Worker를 받지 않는다(Page·Frame만)
 */
async function workerHeapBytes(browser) {
  const b = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await b.send('Target.getTargets');
    const w = targetInfos.filter((x) => x.type === 'worker' && x.url.endsWith('/worker.js')).pop();
    if (!w) return null;
    const { sessionId } = await b.send('Target.attachToTarget', { targetId: w.targetId, flatten: false });
    let id = 0;
    const pending = new Map();
    b.on('Target.receivedMessageFromTarget', (ev) => {
      const m = JSON.parse(ev.message);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    });
    const send = (method, params = {}) =>
      new Promise((ok) => {
        const i = ++id;
        pending.set(i, ok);
        b.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: i, method, params }) });
      });
    await send('HeapProfiler.collectGarbage');
    const r = await send('Runtime.getHeapUsage');
    await b.send('Target.detachFromTarget', { sessionId });
    return r.result?.usedSize ?? null;
  } finally {
    await b.detach();
  }
}

test('K5 PoC 5만 석 좌석맵을 Worker에서 풀어 그리고 §5.2 예산(풀기 250ms·첫 그림 100ms·메시지 p95 2ms·긴 작업 0) 안이다', async ({ page, browser, browserName }, info) => {
  const meta = info.project.metadata ?? {};
  if (meta.throttle) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: meta.throttle });
  }
  await page.goto('/index.html');
  await page.waitForFunction(() => window.__seatmapPoc?.done === true, null, { timeout: 90_000 });
  const r = await page.evaluate(() => window.__seatmapPoc);
  mkdirSync(new URL('../reports/seatmap/', import.meta.url), { recursive: true });
  if (r.unsupported) {
    // 판정 조건(Chromium)에서는 실패, 다른 엔진은 기록하고 건너뛴다(예: Windows용 Playwright WebKit에는 OffscreenCanvas가 없다)
    writeFileSync(new URL(`../reports/seatmap/${info.project.name}.json`, import.meta.url), `${JSON.stringify({ project: info.project.name, userAgent: r.userAgent, unsupported: r.unsupported }, null, 2)}\n`);
    expect(meta.judge, r.unsupported).toBeFalsy();
    test.skip(true, `${r.unsupported}: ${r.userAgent}`);
  }
  expect(r.error, r.error).toBeUndefined();
  const t = r.ready.t;
  const summary = {
    project: info.project.name,
    userAgent: r.userAgent,
    throttle: meta.throttle ?? 1,
    seats: r.ready.seatCount,
    // 'Worker 시작까지'를 메인 몫(Worker 만들기·캔버스 넘기기·init 보내기)과 Worker 쪽(스크립트 받기·실행·init 받기)으로 나눈다
    mainBootMs: Math.round(r.ready.postedAt - r.ready.startedAt),
    workerBootMs: Math.round(t.workerStart - r.ready.postedAt),
    // 대기 중 미리 받기(네트워크, br이면 brotli 풀기 포함)와, Worker의 받기(HTTP 캐시에서 읽기 + brotli 풀기)
    prefetch: { ms: Math.round(r.prefetch.ms), encoding: r.prefetch.encoding, bytes: r.prefetch.bytes },
    encoding: r.ready.encoding,
    fromCache: r.ready.fromCache,
    fetchMs: Math.round(t.fetched - t.workerStart),
    parseMs: Math.round(t.parsed - t.fetched),
    decodeMs: Math.round(t.decoded - t.parsed),
    gridMs: Math.round(t.indexed - t.decoded),
    stage3Ms: Math.round(t.indexed - r.ready.startedAt),
    stage5Ms: Math.round(t.overviewFrame - t.indexed),
    overviewDrawMs: Math.round(t.overviewDrawn - t.indexed),
    frameWaitMs: Math.round(t.overviewFrame - t.overviewDrawn),
    mid: { ...r.ready.mid, directMs: +r.ready.mid.directMs.toFixed(1), prerenderMs: +r.ready.mid.prerenderMs.toFixed(1), blitMs: +r.ready.mid.blitMs.toFixed(1), bitmapMB: +(r.ready.mid.bitmapBytes / 1048576).toFixed(1) },
    close: { drawn: r.ready.close.drawn, ms: +r.ready.close.ms.toFixed(1) },
    deltaMs: +r.ready.deltaMs.toFixed(2),
    hitAvgUs: +r.ready.hit.avgUs.toFixed(1),
    hits: r.ready.hit.hits,
    messages: { count: r.messages.count, handleP95Ms: +r.messages.handleP95Ms.toFixed(3), handleMaxMs: +r.messages.handleMaxMs.toFixed(3), latencyP95Ms: +r.messages.latencyP95Ms.toFixed(2) },
    longTasks: r.longTasks,
    // 풀기 뒤 Worker 힙(GC 뒤, MB = 2^20바이트). Chromium만 잴 수 있다
    workerHeapMB: browserName === 'chromium' ? toMB(await workerHeapBytes(browser)) : null,
  };
  // CDP의 CPU 느리게 하기는 메인 스레드에만 걸리고 Worker에는 걸리지 않는다(Worker 대상에는 보낼 수도 없다, judge.mjs 머리 주석).
  // 그래서 판정은 Worker 스레드 몫(Worker 쪽 시작, 받기·풀기·색인, 그리기, 첫 프레임 기다림)을 그 배수만큼 곱한 보수적 어림으로 한다
  const k = meta.throttle ?? 1;
  summary.judged = judgeK5(summary, k);
  // 되풀이마다 파일 하나(seatmap/report.mjs가 중앙값·최댓값으로 모은다)
  writeFileSync(new URL(`../reports/seatmap/${info.project.name}-${info.repeatEachIndex}.json`, import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
  expect(summary.seats).toBe(50_000);
  expect(summary.messages.count).toBe(210);
  expect(summary.hitAvgUs).toBeGreaterThan(0);
  expect(summary.hits, '누른 좌석 찾기가 화면 안 점 1,000개 가운데 좌석을 맞힌 수').toBeGreaterThan(0);
  if (!meta.judge) return;
  expect(summary.judged.stage3Ms, `단계 3(풀기·색인, Worker 몫 ×${k}) ${summary.judged.stage3Ms}ms`).toBeLessThanOrEqual(BUDGET.stage3Ms);
  expect(summary.judged.stage5Ms, `단계 5(첫 그림, 그리기 ×${k}) ${summary.judged.stage5Ms}ms`).toBeLessThanOrEqual(BUDGET.stage5Ms);
  expect(summary.messages.handleP95Ms, `메시지 처리 p95 ${summary.messages.handleP95Ms}ms`).toBeLessThanOrEqual(BUDGET.messageP95Ms);
  expect(summary.longTasks, '메인 스레드 긴 작업').toEqual([]);
});

// 힙 비교(Chromium만, 판정 없음): ?keep=json이면 Worker가 풀기 뒤에도 JSON 전체를 쥔다(예전 방식). 지금 방식의 workerHeapMB와 견준다
test('K5 PoC 힙 비교: 풀기 뒤 JSON 전체를 쥐던 예전 방식의 Worker 힙을 기록한다', async ({ page, browser, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Worker 힙은 Chromium 개발자 도구 규약으로만 잰다');
  await page.goto('/index.html?keep=json');
  await page.waitForFunction(() => window.__seatmapPoc?.done === true, null, { timeout: 90_000 });
  const r = await page.evaluate(() => window.__seatmapPoc);
  expect(r.error, r.error).toBeUndefined();
  const heap = toMB(await workerHeapBytes(browser));
  mkdirSync(new URL('../reports/seatmap/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../reports/seatmap/${info.project.name}.keep-json.${info.repeatEachIndex}.heap.json`, import.meta.url), `${JSON.stringify({ project: info.project.name, keep: 'json', workerHeapMB: heap }, null, 2)}
`);
  expect(heap).toBeGreaterThan(0);
});
