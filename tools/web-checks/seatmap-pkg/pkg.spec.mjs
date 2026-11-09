// @peaket/seatmap을 실제 브라우저 세 엔진에서 본다(BUILD_ORDER HOT-120, HOT-110이 넘긴 것, docs/frontend.md §5.2·§1.5).
// 시연 페이지(packages/seatmap/demo, `pnpm --filter @peaket/seatmap demo:build` → dist-demo)를 띄워
// ① 첫 그림(전체 배치)의 구역 면이 등급 색(heat.3)이다(캔버스 화소 크기가 화면 × dpr로 맞아야 그 자리에 그 색이 나온다)
// ② 구역으로 확대하고 더 확대하면 고를 수 있는 단계가 되고, 판매 좌석은 sold 색, 가능 좌석은 available 색이다
// ③ 가능 좌석을 누르면 그 좌석 ID가 오고(시연 페이지가 곧 고른다), 그 자리가 mine 색이 된다 ④ 좌석 단계에서 미니맵이 그려진다
// ⑤ Chromium에서 첫 그림 시각(ready.firstPaintAt)을 성능 추적의 프레임 그리기 기록(DrawFrame)과 맞춰 본다.
// Windows의 Playwright WebKit은 OffscreenCanvas가 없어 메인 스레드 대체로 그린다(그 길도 같은 기준으로 본다).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { repoRoot } from '../lib/canon.mjs';
import { join } from 'node:path';

const layout = JSON.parse(readFileSync(join(repoRoot, 'packages/seatmap/dist-demo/layout.json'), 'utf8'));
const TOKENS = readFileSync(join(repoRoot, 'packages/ds/src/gen/tokens.ts'), 'utf8');
/** tokens.ts에서 라이트 색 하나(`"이름": "#rrggbb"`의 첫 번째) */
const token = (name) => {
  const m = new RegExp(`"${name}": "(#[0-9a-fA-F]{6})"`).exec(TOKENS);
  if (!m) throw new Error(`토큰 ${name}이 없다`);
  return m[1].toLowerCase();
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function waitMsg(page, pred, label) {
  await expect.poll(() => page.evaluate((src) => window.__seatmap.messages.some(new Function('m', `return ${src}`)), pred), { message: label, timeout: 15_000 }).toBe(true);
  return page.evaluate((src) => window.__seatmap.messages.filter(new Function('m', `return ${src}`)).at(-1), pred);
}

/** 캔버스를 찍어 CSS px 점들의 색을 읽는다(같은 페이지의 2D 캔버스로 PNG를 푼다) */
async function pixels(page, points) {
  const png = await page.locator('#map').screenshot();
  return page.evaluate(
    async ({ b64, points }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const img = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const k = img.width / 640;
      return points.map(([x, y]) => [...ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)]);
    },
    { b64: png.toString('base64'), points },
  );
}

const seat = (s, offset) => {
  const sec = layout.sections[s];
  return { x: sec.seats.x[offset], y: sec.seats.y[offset], id: sec.seats.seatId[offset] };
};

// 같은 기준으로 두 길을 본다: Worker(OffscreenCanvas) 길과 메인 스레드 대체 길(?main=1, FE-T15)
for (const [path, label] of [['/', 'Worker 길'], ['/?main=1', '메인 스레드 대체 길']]) {
test(`HOT-120 ${label}: 첫 그림은 전체 배치이고, 구역 확대 → 고를 수 있는 배율에서 상태 색이 맞고 누른 좌석이 mine이 되며 미니맵이 있다`, async ({ page, browserName }, info) => {
  await page.goto(path);
  const ready = await waitMsg(page, "m.type === 'ready'", 'ready');
  expect(ready).toMatchObject({ seatCount: 5000, sectionCount: 10, layoutVersion: 1 });
  const mode = await page.evaluate(() => window.__seatmap.mode);
  info.annotations.push({ type: 'mode', description: `${browserName}: ${mode}, 첫 그림 ${Math.round(ready.firstPaintAt - (await page.evaluate(() => window.__seatmap.started)))}ms` });
  let view = await waitMsg(page, "m.type === 'view'", 'view');
  expect(view.level).toBe('overview');

  // ① 0구역 면 가운데(라벨 글자와 떨어진 곳)는 가장 비싼 등급 색 heat.3
  const cam0 = view.camera;
  const s0 = layout.sections[0].shape.points;
  const fx = ((s0[0][0] + s0[1][0]) / 2) * cam0.scale + cam0.tx;
  const fy = (s0[0][1] + (s0[2][1] - s0[0][1]) * 0.7) * cam0.scale + cam0.ty;
  const [face] = await pixels(page, [[fx, fy]]);
  expect(near(face, rgb(token('heat-3'))), `면 색 ${face} ≠ heat-3`).toBe(true);

  // ② 0구역으로 확대한 뒤 고를 수 있을 때까지 확대한다
  await page.evaluate(() => window.__seatmap.send({ type: 'focusSection', section: 0 }));
  view = await waitMsg(page, "m.type === 'view' && m.level === 'seats'", '좌석 단계');
  for (let i = 0; i < 6 && !view.selectable; i++) {
    await page.click('#zin');
    view = await waitMsg(page, `m.type === 'view' && m.zoom > ${view.zoom}`, '확대');
  }
  expect(view.selectable).toBe(true);
  const cam = view.camera;
  const size = 50 * cam.scale * 0.8;
  const at = (p, dx = 0, dy = 0) => [p.x * cam.scale + cam.tx + dx * size, p.y * cam.scale + cam.ty + dy * size];
  // 화면 가운데에 가장 가까운 가능 좌석(0구역 앞 100석은 판매)
  const center = [(320 - cam.tx) / cam.scale, (240 - cam.ty) / cam.scale];
  let pick = -1;
  let best = Infinity;
  for (let i = 100; i < 499; i++) {
    const p = seat(0, i);
    const d = (p.x - center[0]) ** 2 + (p.y - center[1]) ** 2;
    if (d < best) [best, pick] = [d, i];
  }
  const free = seat(0, pick);
  const [freeColor] = await pixels(page, [at(free, -0.4, 0)]);
  expect(near(freeColor, rgb(token('available'))), `가능 좌석 ${freeColor}`).toBe(true);

  // ③ 가능 좌석을 누르면 그 좌석 ID가 오고 mine 색이 된다
  const [cx, cy] = at(free);
  await page.locator('#map').click({ position: { x: cx, y: cy } });
  const hit = await waitMsg(page, "m.type === 'hit' && m.seatIndex >= 0", '누른 좌석');
  expect(hit.seatId).toBe(free.id);
  await waitMsg(page, "m.type === 'selection' && m.seatIndexes.length === 1", '고른 좌석');
  await expect.poll(async () => near((await pixels(page, [at(free, 0.4, 0.4)]))[0], rgb(token('mine'))), { message: 'mine 색', timeout: 5_000 }).toBe(true);

  // ④ 좌석 단계에서는 오른쪽 아래 미니맵에 지금 보는 범위 사각형(text 색 2px 테두리)이 있다
  const mw = 120;
  const s = mw / layout.canvas.width;
  const mh = mw * (layout.canvas.height / layout.canvas.width);
  const ox = 640 - mw - 12;
  const oy = 480 - mh - 12;
  const v = { x: -cam.tx / cam.scale, y: -cam.ty / cam.scale, w: 640 / cam.scale, h: 480 / cam.scale };
  const [edge] = await pixels(page, [[ox + (v.x - layout.canvas.minX) * s, oy + (v.y + v.h / 2 - layout.canvas.minY) * s]]);
  expect(near(edge, rgb(token('text')), 90), `미니맵 범위 테두리 ${edge}`).toBe(true);

  // ⑤ 판매 좌석(0구역 앞 100석) 쪽으로 카메라를 옮겨 판매 색(sold)인지 본다. X 무늬를 비켜 왼쪽 가장자리 쪽을 읽는다
  const soldSeat = seat(0, 37);
  const n = (await page.evaluate(() => window.__seatmap.messages.length));
  await page.evaluate(([z, x, y]) => window.__seatmap.send({ type: 'camera', zoom: z, x, y }), [view.zoom, soldSeat.x, soldSeat.y]);
  const moved = await waitMsg(page, `m.type === 'view' && window.__seatmap.messages.indexOf(m) >= ${n}`, '판매 좌석 쪽 카메라');
  const c2 = moved.camera;
  const s2 = 50 * c2.scale * 0.8;
  const [soldColor] = await pixels(page, [[soldSeat.x * c2.scale + c2.tx - 0.4 * s2, soldSeat.y * c2.scale + c2.ty]]);
  expect(near(soldColor, rgb(token('sold'))), `판매 좌석 ${soldColor}`).toBe(true);
});
}

test('HOT-120 Chromium: 첫 그림 시각(ready.firstPaintAt)이 성능 추적의 프레임 그리기 기록과 맞는다', async ({ page, browser, browserName }, info) => {
  test.skip(browserName !== 'chromium', '성능 추적(startTracing)은 Chromium만 된다');
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing'] });
  await page.goto('/');
  const ready = await waitMsg(page, "m.type === 'ready'", 'ready');
  // 시계 맞추기: 사용자 표시 하나의 추적 시각(µs)과 그 표시의 절대 시각(ms)
  const markEpoch = await page.evaluate(() => {
    const m = performance.mark('seatmap-clock');
    return performance.timeOrigin + m.startTime;
  });
  await page.waitForTimeout(300);
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));
  const events = trace.traceEvents ?? trace;
  const mark = events.find((e) => e.name === 'seatmap-clock');
  expect(mark, '추적에 사용자 표시가 없다').toBeTruthy();
  const toEpoch = (ts) => markEpoch + (ts - mark.ts) / 1000;
  const frames = events.filter((e) => e.name === 'DrawFrame').map((e) => toEpoch(e.ts)).sort((a, b) => a - b);
  expect(frames.length, 'DrawFrame 기록이 없다').toBeGreaterThan(0);
  // Worker가 다음 화면 갱신 뒤 잰 첫 그림 시각 바로 앞뒤의 프레임 그리기 기록
  // 그리기 명령을 다 낸 뒤(drawnAt)의 첫 프레임 그리기 기록이 첫 그림을 화면에 낸 프레임이다(그 전 프레임은 페이지 글자·버튼만 담는다)
  const presented = frames.find((t) => t >= ready.drawnAt);
  expect(presented, 'drawnAt 뒤 프레임 기록이 없다').toBeDefined();
  const wait = presented - ready.drawnAt;
  const delta = ready.firstPaintAt - presented;
  info.annotations.push({ type: 'first-paint', description: `drawnAt 뒤 첫 DrawFrame까지 ${wait.toFixed(1)}ms, firstPaintAt − 그 프레임 = ${delta.toFixed(1)}ms(프레임 ${frames.length}개)` });
  // 그리기 뒤 두 프레임(60Hz 약 16.7ms × 2) 안에 화면에 나가고, Worker가 잰 첫 그림 시각이 그 프레임과 두 프레임 안이다 [가정]
  expect(wait, `그리기 뒤 ${wait.toFixed(1)}ms에야 프레임이 나갔다`).toBeLessThanOrEqual(34);
  expect(Math.abs(delta), `첫 그림 시각이 화면에 낸 프레임과 ${delta.toFixed(1)}ms 다르다`).toBeLessThanOrEqual(34);
});
