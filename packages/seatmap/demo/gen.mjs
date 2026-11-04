// 시연 페이지용 좌석맵 파일과 스냅샷(BUILD_ORDER HOT-120). 구역 열 개 × 500석, 0구역 앞 100석은 판매(스냅샷 점유), 마지막 좌석은 판매 제외.
//   node demo/gen.mjs   → demo/public/layout.json, demo/public/snapshot.bin
import { mkdirSync, writeFileSync } from 'node:fs';

const SECTIONS = 10;
const ROWS = 20;
const PER_ROW = 25;
const PITCH = 55;
const GAP = 120;
const tiers = ['VIP', 'R', 'S', 'A'];
const secW = PER_ROW * PITCH;
const width = 5 * (secW + GAP) + 400;
const height = 2 * (ROWS * PITCH + GAP) + 900;
const layout = {
  format: 'peaket.seatmap.columns.v1',
  layoutVersion: 1,
  canvas: { minX: 0, minY: 0, width, height },
  stage: [{ kind: 'RECT', points: [[width / 2 - 1200, 100], [width / 2 + 1200, 100], [width / 2 + 1200, 500], [width / 2 - 1200, 500]] }],
  tiers,
  seatCount: SECTIONS * ROWS * PER_ROW,
  sections: [],
};
let next = 0;
for (let s = 0; s < SECTIONS; s++) {
  const x0 = 200 + (s % 5) * (secW + GAP);
  const y0 = 800 + Math.floor(s / 5) * (ROWS * PITCH + GAP);
  const c = { seatId: [], row: [], number: [], x: [], y: [], tier: [], flags: [] };
  for (let r = 0; r < ROWS; r++) {
    for (let n = 0; n < PER_ROW; n++) {
      c.seatId.push(`S${s}-R${r + 1}-${n + 1}`);
      c.row.push(String(r + 1));
      c.number.push(String(n + 1));
      c.x.push(x0 + n * PITCH + PITCH / 2);
      c.y.push(y0 + r * PITCH + PITCH / 2);
      c.tier.push(Math.min(3, Math.floor(s / 3)));
      c.flags.push(r === ROWS - 1 && n === PER_ROW - 1 ? 2 : r === 0 && n === 0 ? 1 : 0);
    }
  }
  const n = ROWS * PER_ROW;
  layout.sections.push({
    sectionId: `S${s}`,
    name: `${s + 1}구역`,
    shape: { kind: 'RECT', points: [[x0, y0], [x0 + secW, y0], [x0 + secW, y0 + ROWS * PITCH], [x0, y0 + ROWS * PITCH]] },
    label: { x: x0 + secW / 2, y: y0 - 40 },
    seatIndexRange: { from: next, to: next + n - 1 },
    seats: c,
  });
  next += n;
}

// 스냅샷: version 1, flags 0, layoutVersion, seatEpoch 1, 구역마다 (색인, 판 1), 비트맵(앞 100석 점유)
const N = layout.seatCount;
const buf = new Uint8Array(12 + SECTIONS * 6 + Math.ceil(N / 8));
const v = new DataView(buf.buffer);
v.setUint8(0, 1);
v.setUint32(2, layout.layoutVersion, true);
v.setUint32(6, 1, true);
v.setUint16(10, SECTIONS, true);
for (let s = 0; s < SECTIONS; s++) {
  v.setUint16(12 + s * 6, s, true);
  v.setUint32(14 + s * 6, 1, true);
}
const bm = 12 + SECTIONS * 6;
for (let i = 0; i < 100; i++) buf[bm + (i >> 3)] |= 1 << (i & 7);

const out = new URL('./public/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('layout.json', out), JSON.stringify(layout));
writeFileSync(new URL('snapshot.bin', out), buf);
console.log(`좌석맵 ${N}석, 구역 ${SECTIONS}개 → demo/public/`);
