// FE-T33 좌석맵 에디터 편집 캔버스 측정(docs/frontend.md §5.17 FE-T33, 측정 캠페인 LCH-200·wbs 7.5.2). 평소에는 건너뛴다(PEAKET_MEASURE_FE_T33=1일 때만).
// STADIUM 크기(약 5만 석) 시험 배치(플로어 사각형 6개 + 스탠드 곡선 띠 30개)를 가짜 API로 열고 ① 구역 하나를 5초 끌기 ② 회전 손잡이로 5초 돌리기
// ③ 좌석 다듬기에서 상자로 약 1,000석을 골라 화살표로 옮기기를 CPU 스로틀 없이 한 번, 4배 느린 CPU(Chromium CDP)로 한 번 잰다.
// 프레임 시간은 requestAnimationFrame 간격, 긴 작업은 longtask, 조작 지연은 Event Timing(keydown·pointer) duration이다. 결과는 reports/fe-t33.json.
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const API = 'https://partner-api.peaket.example';
const ID = '0b8f1f2e-4a1d-4c1e-9b5a-0000000fe033';
const CW = 30_000;
const CH = 24_000;

/** STADIUM 크기 시험 배치(좌석 49,920석) */
function stadium() {
  const sections = [];
  const tiers = [{ tierId: 'R', name: 'R석', price: 150_000 }, { tierId: 'S', name: 'S석', price: 110_000 }, { tierId: 'A', name: 'A석', price: 80_000 }];
  let n = 0;
  // 플로어: 사각형 6개(3 × 2), 구역마다 40행 × 40석 = 1,600석
  for (let i = 0; i < 6; i++) {
    const x = 9_500 + (i % 3) * 3_800;
    const y = 8_500 + Math.floor(i / 3) * 3_800;
    const seats = [];
    for (let r = 0; r < 40; r++) for (let c = 0; c < 40; c++) seats.push({ seatId: `f${i}-${r}-${c}`, row: String(r + 1), number: c + 1, x: x + 100 + c * 85, y: y + 100 + r * 85 });
    sections.push({ sectionId: `F${i + 1}`, name: `플로어 ${i + 1}`, tierId: 'R', shape: { kind: 'RECT', points: [[x, y], [x + 3_600, y], [x + 3_600, y + 3_600], [x, y + 3_600]] }, seats });
    n += seats.length;
  }
  // 스탠드: 곡선 띠 30개(12도씩), 구역마다 24행 × 54석 = 1,296석
  const cx = 15_000;
  const cy = 12_000;
  for (let k = 0; k < 30; k++) {
    const a0 = k * 12;
    const a1 = a0 + 11;
    const arc = { cx, cy, innerRadius: 8_500, outerRadius: 11_000, startAngle: a0, endAngle: a1 };
    const pts = [];
    for (let i = 0; i <= 11; i++) pts.push([Math.round(cx + 11_000 * Math.cos(((a0 + i) * Math.PI) / 180)), Math.round(cy + 11_000 * Math.sin(((a0 + i) * Math.PI) / 180))]);
    for (let i = 11; i >= 0; i--) pts.push([Math.round(cx + 8_500 * Math.cos(((a0 + i) * Math.PI) / 180)), Math.round(cy + 8_500 * Math.sin(((a0 + i) * Math.PI) / 180))]);
    const seats = [];
    for (let r = 0; r < 24; r++) {
      const R = 8_600 + r * 100;
      for (let c = 0; c < 54; c++) {
        const t = ((a0 + 0.3 + (c * 10.4) / 53) * Math.PI) / 180;
        seats.push({ seatId: `s${k}-${r}-${c}`, row: String(r + 1), number: c + 1, x: Math.round(cx + R * Math.cos(t)), y: Math.round(cy + R * Math.sin(t)) });
      }
    }
    sections.push({ sectionId: `S${k + 1}`, name: `스탠드 ${k + 1}`, tierId: k % 2 ? 'S' : 'A', shape: { kind: 'ARC_BAND', points: pts, arc }, seats });
    n += seats.length;
  }
  return { layout: { layoutVersion: 1, geometryLocked: false, priceTiers: tiers, canvas: { width: CW, height: CH }, stage: [{ kind: 'RECT', name: '무대', points: [[13_000, 1_000], [17_000, 1_000], [17_000, 2_500], [13_000, 2_500]] }], sections }, seats: n };
}

const p95 = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 10) / 10;
};

async function startProbe(page) {
  await page.evaluate(() => {
    const m = { frames: [], long: [], events: [] };
    globalThis.__fet33 = m;
    let last = performance.now();
    const tick = (t) => {
      m.frames.push(t - last);
      last = t;
      if (!m.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => l.getEntries().forEach((e) => m.long.push(e.duration))).observe({ type: 'longtask', buffered: false });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => m.events.push({ name: e.name, d: e.duration }))).observe({ type: 'event', durationThreshold: 16, buffered: false });
  });
}
async function stopProbe(page) {
  return page.evaluate(() => {
    const m = globalThis.__fet33;
    m.stop = true;
    return { frames: m.frames.slice(1), long: m.long, events: m.events };
  });
}

for (const rate of [1, 4]) {
  test(`FE-T33 측정 STADIUM 5만 석 끌기·돌리기·1,000석 옮기기(CPU ${rate}배)`, async ({ page, browserName }) => {
    test.skip(process.env.PEAKET_MEASURE_FE_T33 !== '1', '측정 캠페인(LCH-200) 때만 돈다');
    test.skip(browserName !== 'chromium', 'CPU 느리게 하기는 Chromium CDP로만 한다');
    test.setTimeout(180_000);
    const { layout, seats } = stadium();
    await page.route(`${API}/**`, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': new URL(test.info().project.use.baseURL).origin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'ETag', 'content-type': 'application/json', etag: '"1"' }, body: JSON.stringify(layout) }));
    await page.setViewportSize({ width: 1600, height: 1000 });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`/events/${ID}/seatmap`);
    await expect(page.getByTestId('summary-seats')).toHaveText(`좌석 ${seats.toLocaleString('ko-KR')}`, { timeout: 60_000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const box = await page.getByTestId('seatmap-canvas').boundingBox();
    const s = Math.min(box.width / CW, box.height / CH) * 0.95;
    const at = (x, y) => [box.x + (box.width - CW * s) / 2 + x * s, box.y + (box.height - CH * s) / 2 + y * s];
    const out = {};

    // ① 플로어 2(곡선 띠가 아니라 사각형)를 골라 5초 끈다
    const tree = page.getByRole('tree', { name: '좌석 계층' });
    await tree.getByRole('treeitem', { name: /플로어 2/ }).click();
    // 자리는 속성 패널의 숫자(첫 꼭짓점·가로·세로)로 읽어 맞춤 보기 좌표로 바꾼다
    const rect = async () => ({ x: Number(await page.locator('#sp-x').inputValue()), y: Number(await page.locator('#sp-y').inputValue()), w: Number(await page.locator('#sp-w').inputValue()), h: Number(await page.locator('#sp-h').inputValue()) });
    const r0 = await rect();
    const [fx, fy] = at(r0.x + r0.w / 2, r0.y + r0.h / 2);
    await startProbe(page);
    let t0 = Date.now();
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    for (let i = 0; Date.now() - t0 < 5_000; i++) await page.mouse.move(fx + 40 * Math.sin(i / 8), fy + 30 * Math.cos(i / 8));
    await page.mouse.up();
    let m = await stopProbe(page);
    out.dragMovedTo = await page.locator('#sp-x').inputValue({ timeout: 2_000 }).catch(() => null);
    out.drag = { frameP95: p95(m.frames), frames: m.frames.length, longTasks: m.long.length, longMax: Math.max(0, ...m.long) };

    // ② 같은 사각형을 회전 손잡이(위 가운데에서 50px 위)로 5초 돌린다
    await page.waitForTimeout(500);
    const r1 = await rect();
    const [rx, ry] = at(r1.x + r1.w / 2, r1.y);
    const [ox, oy] = at(r1.x + r1.w / 2, r1.y + r1.h / 2);
    await startProbe(page);
    t0 = Date.now();
    await page.mouse.move(rx, ry - 50);
    await page.mouse.down();
    for (let i = 0; Date.now() - t0 < 5_000; i++) {
      const a = -Math.PI / 2 + Math.sin(i / 10) * 1.2;
      await page.mouse.move(ox + 120 * Math.cos(a), oy + 120 * Math.sin(a));
    }
    await page.mouse.up();
    m = await stopProbe(page);
    out.rotatedTo = await page.locator('#sp-rot').inputValue({ timeout: 2_000 }).catch(() => null);
    out.rotate = { frameP95: p95(m.frames), frames: m.frames.length, longTasks: m.long.length, longMax: Math.max(0, ...m.long) };

    // ③ 좌석 다듬기: 상자로 플로어 1의 좌석 약 1,000석을 고르고 화살표 10번
    await page.getByRole('tab', { name: /좌석 다듬기/ }).click();
    // 상자는 플로어 1 도형 밖(좌석에서 2m 넘게 떨어진 곳)에서 시작한다(누른 자리에 좌석이 있으면 그 좌석을 끈다)
    const [bx0, by0] = at(9_300, 8_300);
    const [bx1, by1] = at(9_600 + 85 * 31 + 40, 8_600 + 85 * 31 + 40);
    await page.mouse.move(bx0, by0);
    await page.mouse.down();
    await page.mouse.move(bx1, by1, { steps: 6 });
    await page.mouse.up();
    const picked = await page.getByRole('status').filter({ hasText: /석 선택$/ }).textContent();
    await startProbe(page);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
    }
    m = await stopProbe(page);
    const keys = m.events.filter((e) => e.name.startsWith('key')).map((e) => e.d);
    out.move = { picked, keyEventMaxMs: Math.max(0, ...keys), keyEvents: keys.length, frameP95: p95(m.frames), longTasks: m.long.length, longMax: Math.max(0, ...m.long) };
    // 장면 노드 수: 층 4 + 무대 1 + 구역마다 Line·Text·좌석 Shape 3 + 조작 층 기본 노드(안내선 2·치수·상자·그리던 선·Transformer·사각형 대역·손잡이 묶음)
    out.nodes = 4 + 1 + layout.sections.length * 3 + 8;
    out.seats = seats;
    out.cpuRate = rate;
    mkdirSync('reports', { recursive: true });
    const file = 'reports/fe-t33.json';
    let all = {};
    try {
      all = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
    } catch {
      all = {};
    }
    all[`cpu${rate}x`] = out;
    writeFileSync(file, JSON.stringify(all, null, 2));
    console.log(`FE-T33 CPU ${rate}배: ${JSON.stringify(out)}`);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
}
