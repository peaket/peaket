// K5 PoC: 5만 석 열 단위 좌석맵 파일을 Worker의 OffscreenCanvas로 풀고 그린다(BUILD_ORDER BAS-190, docs/frontend.md §5.2).
// 판정(chromium-k5만): §5.2 단계 3 'Worker 시작·캔버스 넘기기·파일 풀기 250ms'(격자 색인 포함), 단계 5 '전체 배치도 첫 그림 100ms',
// 메시지 비용 'p95 2ms', 좌석 화면 '메인 스레드 긴 작업 0'(§5.8). 다른 엔진은 reports/seatmap/<프로젝트>.json에 기록만 한다.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BUDGET = { stage3Ms: 250, stage5Ms: 100, messageP95Ms: 2 };

test('K5 PoC 5만 석 좌석맵을 Worker에서 풀어 그리고 §5.2 예산(풀기 250ms·첫 그림 100ms·메시지 p95 2ms·긴 작업 0) 안이다', async ({ page }, info) => {
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
    workerBootMs: Math.round(t.workerStart - r.ready.startedAt),
    fetchMs: Math.round(t.fetched - t.workerStart),
    parseMs: Math.round(t.parsed - t.fetched),
    decodeMs: Math.round(t.decoded - t.parsed),
    gridMs: Math.round(t.indexed - t.decoded),
    stage3Ms: Math.round(t.indexed - r.ready.startedAt),
    stage5Ms: Math.round(t.overviewFrame - t.indexed),
    overviewDrawMs: Math.round(t.overviewDrawn - t.indexed),
    mid: { ...r.ready.mid, directMs: +r.ready.mid.directMs.toFixed(1), prerenderMs: +r.ready.mid.prerenderMs.toFixed(1), blitMs: +r.ready.mid.blitMs.toFixed(1), bitmapMB: +(r.ready.mid.bitmapBytes / 1048576).toFixed(1) },
    close: { drawn: r.ready.close.drawn, ms: +r.ready.close.ms.toFixed(1) },
    deltaMs: +r.ready.deltaMs.toFixed(2),
    hitAvgUs: +r.ready.hit.avgUs.toFixed(1),
    hits: r.ready.hit.hits,
    messages: { count: r.messages.count, handleP95Ms: +r.messages.handleP95Ms.toFixed(3), handleMaxMs: +r.messages.handleMaxMs.toFixed(3), latencyP95Ms: +r.messages.latencyP95Ms.toFixed(2) },
    longTasks: r.longTasks,
  };
  // CDP의 CPU 느리게 하기는 메인 스레드에만 걸리고 Worker에는 걸리지 않는다(2026-11-04 잼: Worker 단계가 1.0~1.3배).
  // 그래서 판정은 Worker 몫(받기·풀기·색인, 첫 그림 그리기)을 그 배수만큼 곱한 보수적 어림으로 한다
  const k = meta.throttle ?? 1;
  summary.judged = {
    stage3Ms: summary.workerBootMs + k * (summary.fetchMs + summary.parseMs + summary.decodeMs + summary.gridMs),
    stage5Ms: k * summary.overviewDrawMs + (summary.stage5Ms - summary.overviewDrawMs),
  };
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
