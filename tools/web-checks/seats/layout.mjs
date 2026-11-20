// 5만 석 좌석맵 자료와 스냅샷(S-T21·S-T31 ⑥, BAT-182). 시험 서버와 setup이 함께 쓴다. 제품 코드가 아니다.
// 구역 25개 × 2,000석(40행 × 50석) = 50,000석. 5×5 배치라 확대하면 한 구역만 화면 폭 1/3 이상으로 보인다.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EVENT_ID = 'evt-50k';
export const SECTIONS = 25;
export const ROWS = 40;
export const PER_ROW = 50;
export const SEATS_PER_SECTION = ROWS * PER_ROW;
export const SEAT_COUNT = SECTIONS * SEATS_PER_SECTION;
export const LAYOUT_VERSION = 1;
const PITCH = 55;
const GAP = 600;
const SEC_W = PER_ROW * PITCH;
const SEC_H = ROWS * PITCH;
const LEFT = 200;
const TOP = 800;
const COLS = 5;
const CANVAS = { minX: 0, minY: 0, width: LEFT * 2 + COLS * SEC_W + (COLS - 1) * GAP, height: TOP + 5 * SEC_H + 4 * GAP + 200 };

/** 같은 자리의 좌석맵 파일(값은 매번 같다) */
export function generateLayout() {
  const layout = {
    format: 'peaket.seatmap.columns.v1',
    layoutVersion: LAYOUT_VERSION,
    canvas: CANVAS,
    stage: [{ kind: 'RECT', points: [[CANVAS.width / 2 - 2_500, 100], [CANVAS.width / 2 + 2_500, 100], [CANVAS.width / 2 + 2_500, 500], [CANVAS.width / 2 - 2_500, 500]] }],
    tiers: ['VIP', 'R', 'S', 'A'],
    seatCount: SEAT_COUNT,
    sections: [],
  };
  let next = 0;
  for (let s = 0; s < SECTIONS; s++) {
    const x0 = LEFT + (s % COLS) * (SEC_W + GAP);
    const y0 = TOP + Math.floor(s / COLS) * (SEC_H + GAP);
    const c = { seatId: [], row: [], number: [], x: [], y: [], tier: [], flags: [] };
    for (let r = 0; r < ROWS; r++) {
      for (let n = 0; n < PER_ROW; n++) {
        c.seatId.push(`S${s}-R${r + 1}-${n + 1}`);
        c.row.push(String(r + 1));
        c.number.push(String(n + 1));
        c.x.push(x0 + n * PITCH + 27);
        c.y.push(y0 + r * PITCH + 27);
        c.tier.push(Math.min(3, Math.floor(s / 7)));
        // 첫 좌석은 휠체어석(1), 마지막 좌석은 판매(2)다(그리기 상태 확인용)
        c.flags.push(r === 0 && n === 0 ? 1 : r === ROWS - 1 && n === PER_ROW - 1 ? 2 : 0);
      }
    }
    layout.sections.push({
      sectionId: `S${s}`,
      name: `${s + 1}구역`,
      shape: { kind: 'RECT', points: [[x0, y0], [x0 + SEC_W, y0], [x0 + SEC_W, y0 + SEC_H], [x0, y0 + SEC_H]] },
      label: { x: x0 + SEC_W / 2, y: y0 - 40 },
      seatIndexRange: { from: next, to: next + SEATS_PER_SECTION - 1 },
      seats: c,
    });
    next += SEATS_PER_SECTION;
  }
  return layout;
}

/** 스냅샷 이진 자료(u8 version, u8 flags, u32 layoutVersion, u32 seatEpoch, u16 count, (u16, u32)*, 비트맵) */
function snapshotBytes(flags, seatEpoch, sections, bits) {
  const bitmapBytes = Math.ceil(bits / 8);
  const u8 = new Uint8Array(12 + sections.length * 6 + bitmapBytes);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, flags);
  v.setUint32(2, LAYOUT_VERSION, true);
  v.setUint32(6, seatEpoch, true);
  v.setUint16(10, sections.length, true);
  let p = 12;
  for (const [index, version] of sections) {
    v.setUint16(p, index, true);
    v.setUint32(p + 2, version, true);
    p += 6;
  }
  return u8;
}

/** 전체 스냅샷(flags 0). versions는 구역마다 지금 판 */
export function fullSnapshot(seatEpoch, versions) {
  return snapshotBytes(0, seatEpoch, Array.from({ length: SECTIONS }, (_, s) => [s, versions[s] ?? 1]), SEAT_COUNT);
}

/** 구역 하나의 스냅샷(flags 1) */
export function sectionSnapshot(seatEpoch, section, version) {
  return snapshotBytes(1, seatEpoch, [[section, version]], SEATS_PER_SECTION);
}

/** 좌석맵 파일과 처음 스냅샷을 gen/에 쓴다(setup·서버가 부른다) */
export function writeLayoutFiles(genDir) {
  mkdirSync(genDir, { recursive: true });
  const layout = generateLayout();
  writeFileSync(new URL('layout.json', genDir), JSON.stringify(layout));
  writeFileSync(new URL('snapshot.bin', genDir), fullSnapshot(1, Array(SECTIONS).fill(1)));
  return layout;
}

export const layoutFile = (genDir) => new URL('layout.json', genDir);
export const snapshotFile = (genDir) => new URL('snapshot.bin', genDir);
export const dirOf = (url) => fileURLToPath(url);
