// 좌석맵 랩(F-08-1, docs/frontend.md §5.8 '판정은 둘로 나눈다'·'좌석맵 INP 시나리오'·FE-T10).
// 5만 석(seats 하네스)을 중급 모바일(412×823·배율 2.625)에서 CPU 4배로 열어, Canvas(메인 스레드 대체)와 Worker 길을 회차마다 잰다.
// 회차: 첫 그림(ready) → 계측 비우기 → 휠 확대 3번 → 0구역 초점 → 좌석 10개 누르기 → 1초 쉼 → INP·LCP·CLS·LoAF·긴 작업·메시지 p95·힙.
// 회차 수는 §5.8의 20회 [가정]을 정본에서 읽는다. 로컬 확인은 PEAKET_LAB_REPS=3처럼 줄일 수 있고, 그 결과는 '잠정'이다.
// 망 흉내는 PEAKET_LAB_NETWORK=1일 때만 켠다(Worker fetch에는 걸리지 않을 수 있어 기본은 CPU만).
// 판정은 lib/vitals.mjs·seats/lab-judge.mjs가 한다. 이 파일은 재고 쓰는 일만 한다.
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderLabReport } from '../lib/vitals.mjs';
import { loadLabRuns } from '../lib/canon.mjs';
import { generateLayout, SECTIONS } from './layout.mjs';
import { VITALS_COLLECTOR_SOURCE } from './vitals-collector.mjs';
import { compareModes, judgeMode } from './lab-judge.mjs';

test.describe.configure({ mode: 'serial' });

const REPS = Number(process.env.PEAKET_LAB_REPS ?? loadLabRuns());
if (!Number.isInteger(REPS) || REPS < 1) throw new Error(`PEAKET_LAB_REPS가 틀렸다: ${process.env.PEAKET_LAB_REPS}`);
const NETWORK = process.env.PEAKET_LAB_NETWORK === '1';
const PROFILE = `412×823·배율 2.625·CPU 4배${NETWORK ? '·왕복 150ms·1.6Mbps' : '·망 흉내 끔'}`;
const OUT = new URL('../reports/seats-lab/', import.meta.url);
const VIEWPORT = { width: 412, height: 823 };
const CANVAS = { w: 412, h: 760 };
const layout = generateLayout();

/** 가까운 순위 백분위(회차 안 p95). lib/vitals.mjs의 p75와 같은 규칙(보간 없음) */
const nearRank = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};

/** Worker 대상의 GC 뒤 쓰는 힙(Chromium 개발자 도구 규약). Playwright newCDPSession은 Worker를 받지 않는다 */
async function workerHeapBytes(browser) {
  const b = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await b.send('Target.getTargets');
    const w = targetInfos.filter((x) => x.type === 'worker').pop();
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

/** 한 회차. 새 문맥에서 열고 재고 닫는다 */
async function one(browser, { path, expectedMode }) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript({ content: VITALS_COLLECTOR_SOURCE });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    if (NETWORK) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, connectionType: 'cellular3g' });

    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => window.__seats?.messages.some((m) => m.type === 'ready') ?? false), { message: '첫 그림(ready)', timeout: 30_000 }).toBe(true);
    const boot = await page.evaluate(() => {
      const ready = window.__seats.messages.filter((m) => m.type === 'ready').at(-1);
      return { navStart: window.__seats.navStart, mode: window.__seats.mode, ready };
    });
    const firstPaintMs = boot.ready.firstPaintAt - boot.navStart;

    // 시나리오 시작: 계측과 긴 작업 기록을 비운다
    await page.evaluate(() => {
      window.__peaketVitalsReset();
      window.__seats.reset();
    });
    await page.waitForTimeout(50);

    // 휠 확대 3번(실제 입력 사건) → 0구역 초점
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(CANVAS.w / 2, CANVAS.h / 2);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(80);
    }
    await page.evaluate(() => window.__seats.send({ type: 'focusSection', section: 0 }));
    await expect
      .poll(() => page.evaluate(() => window.__seats.messages.filter((m) => m.type === 'view').at(-1)?.level ?? null), { message: '좌석 단계', timeout: 10_000 })
      .toBe('seats');

    // 화면에 보이는 0구역 좌석 10개를 누른다. 카메라로 화면 좌표를 계산한다
    const view = await page.evaluate(() => window.__seats.messages.filter((m) => m.type === 'view').at(-1));
    const cam = view.camera;
    const sec = layout.sections[0];
    const inside = [];
    for (let i = 0; i < sec.seats.x.length && inside.length < 10; i += 37) {
      const x = sec.seats.x[i] * cam.scale + cam.tx;
      const y = sec.seats.y[i] * cam.scale + cam.ty;
      if (x > 30 && x < CANVAS.w - 30 && y > 30 && y < CANVAS.h - 30) inside.push({ x, y });
    }
    let hits = 0;
    for (const p of inside) {
      const before = await page.evaluate(() => window.__seats.messages.length);
      await page.locator('#map').click({ position: p });
      await page.waitForTimeout(60);
      const after = await page.evaluate((n) => window.__seats.messages.slice(n).some((m) => m.type === 'hit' || m.type === 'selection'), before);
      if (after) hits++;
    }
    // INP·LoAF가 마지막 조작 뒤 갱신될 시간을 준다
    await page.waitForTimeout(1000);

    const out = await page.evaluate(() => {
      const handled = window.__seats.handled;
      return { vitals: window.__peaketVitals, longTasks: window.__seats.longTasks, handled, mode: window.__seats.mode };
    });
    const heap = boot.mode === 'worker' ? await workerHeapBytes(browser) : (await cdp.send('HeapProfiler.collectGarbage'), (await cdp.send('Runtime.getHeapUsage')).usedSize);
    return {
      mode: boot.mode,
      expectedMode,
      seats: boot.ready.seatCount,
      sectionCount: boot.ready.sectionCount,
      firstPaintMs,
      longTasks: out.longTasks,
      loafCount: out.vitals?.loaf?.count ?? 0,
      messageP95Ms: out.handled.length ? nearRank(out.handled, 0.95) : null,
      heapMB: typeof heap === 'number' ? Math.round((heap / 1048576) * 100) / 100 : null,
      clicks: { asked: inside.length, hits },
      vitals: out.vitals,
    };
  } finally {
    await context.close();
  }
}

const PORT = 4131;
const origin = `http://127.0.0.1:${PORT}`;

for (const { name, path, expectedMode, label } of [
  { name: 'worker', path: `/?w=${CANVAS.w}&h=${CANVAS.h}`, expectedMode: 'worker', label: 'Worker(OffscreenCanvas)' },
  { name: 'canvas', path: `/?w=${CANVAS.w}&h=${CANVAS.h}&main=1`, expectedMode: 'main-thread', label: 'Canvas(메인 스레드)' },
]) {
  test(`F081-11 좌석맵 랩 ${name}: 5만 석을 ${REPS}회 열어 첫 그림·INP·긴 작업·LoAF·메시지 p95·힙을 남긴다`, async ({ browser }) => {
    const runs = [];
    for (let i = 0; i < REPS; i++) {
      const r = await one(browser, { path: origin + path, expectedMode });
      runs.push(r);
      // 회차마다 한 줄: 진행을 보이고, 회차가 무효면 까닭이 보이게 한다
      console.log(`[${name} ${i + 1}/${REPS}] firstPaint=${Math.round(r.firstPaintMs)}ms inp=${r.vitals?.inpMs ?? '-'} msgs=${r.clicks.hits}/${r.clicks.asked} long=${r.longTasks?.length ?? '-'}`);
    }
    const { summary, verdict } = judgeMode(runs, { mode: expectedMode, reps: REPS });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify({ name, label, reps: REPS, profile: PROFILE, runs, summary, verdict }, null, 2)}\n`);
    expect(summary.n, '유효 회차').toBeGreaterThan(0);
    expect(verdict.status, verdict.reasons.join(' · ')).not.toBe('unknown');
    // Worker(제품 길)는 FE-T10을 넘어야 한다. Canvas는 비교용이라 실패해도 기록만 한다
    if (expectedMode === 'worker') expect(verdict.status, verdict.reasons.join(' · ')).not.toBe('fail');
  });
}

test('F081-12 좌석맵 랩 보고서: 두 모드의 결과를 한 표와 비교로 남긴다', async () => {
  const read = (n) => JSON.parse(readFileSync(new URL(`${n}.json`, OUT), 'utf8'));
  const worker = read('worker');
  const canvas = read('canvas');
  const cmp = compareModes(canvas.summary, worker.summary);
  const md = renderLabReport({
    reps: REPS,
    profile: PROFILE,
    modes: [
      { name: 'canvas', label: canvas.label, summary: canvas.summary, verdict: canvas.verdict },
      { name: 'worker', label: worker.label, summary: worker.summary, verdict: worker.verdict },
    ],
  });
  const extra = [
    '',
    `- 회차 수: ${REPS}(정본 20회${REPS < loadLabRuns() ? ', 모자라 잠정' : ''})`,
    `- 망 흉내: ${NETWORK ? '켬(왕복 150ms·1.6Mbps)' : '끔(CPU 4배만)'}`,
    `- Canvas/Worker 힙 감축률: ${cmp.heapReduction === null ? '잴 수 없음' : `${(cmp.heapReduction * 100).toFixed(1)}%(보조 숫자, 판정 제외)`}`,
    `- ${cmp.note}`,
    `- v0 문서 인용: docs/verification.md §3.10 2026-11-03 K5 — INP p75 88ms, 그리기 p75 471ms, 긴 작업 31(목표 0을 못 지킴)`,
  ].join('\n');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL('report.md', OUT), `${md}\n${extra}\n`);
  writeFileSync(new URL('summary.json', OUT), `${JSON.stringify({ reps: REPS, profile: PROFILE, network: NETWORK, modes: { worker: worker.verdict, canvas: canvas.verdict }, compare: cmp }, null, 2)}\n`);
  expect(worker.verdict.status).not.toBe('unknown');
  expect(cmp.secondary).toEqual(['heapReduction']);
});
