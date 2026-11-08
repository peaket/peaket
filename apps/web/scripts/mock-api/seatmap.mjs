// 가짜 API의 좌석맵(ADR-0224, BUILD_ORDER HOT-350 ①, docs/frontend.md §4.4.2). 실제 배치 판(2·3)과 이진 스냅샷을 만든다.
// 판 2·3은 같은 배치다(판 번호만 다르다: 스냅샷의 판이 다를 때 좌석맵 파일을 다시 받는 흐름을 본다). 앞 구역이 비싸고, 마지막 구역은 매진이다.

const PITCH = 60; // 좌석 간격 60cm
const ROWS = 12;
const PER_ROW = 20;
const SECTION_W = PER_ROW * PITCH;
const SECTION_H = ROWS * PITCH;
const GAP = 200;
const TOP = 500;
/** 구역(왼쪽 위부터): 이름·등급 색인(tiers 차례) */
const SECTIONS = [
  ['A', 1],
  ['B', 0],
  ['C', 1],
  ['D', 2],
  ['E', 1],
  ['F', 2],
];
const COLS = 3;
export const SEATMAP_VERSIONS = [2, 3];
/** 매진으로 그릴 구역 */
const SOLD_OUT = 5;

export function seatmapLayoutV(layoutVersion) {
  const width = COLS * SECTION_W + (COLS + 1) * GAP;
  const height = TOP + 2 * (SECTION_H + GAP);
  let next = 0;
  const sections = SECTIONS.map(([name, tier], s) => {
    const x0 = GAP + (s % COLS) * (SECTION_W + GAP);
    const y0 = TOP + Math.floor(s / COLS) * (SECTION_H + GAP);
    const c = { seatId: [], row: [], number: [], x: [], y: [], tier: [], flags: [] };
    for (let r = 0; r < ROWS; r++) {
      for (let n = 0; n < PER_ROW; n++) {
        c.seatId.push(`${name}-${r + 1}-${n + 1}`);
        c.row.push(String(r + 1));
        c.number.push(String(n + 1));
        c.x.push(x0 + n * PITCH + PITCH / 2);
        c.y.push(y0 + r * PITCH + PITCH / 2);
        c.tier.push(tier);
        // 첫 줄 앞 두 자리는 휠체어석, 맨 뒷줄 끝 자리는 판매 제외
        c.flags.push(r === 0 && n < 2 ? 1 : r === ROWS - 1 && n === PER_ROW - 1 ? 2 : 0);
      }
    }
    const count = ROWS * PER_ROW;
    const section = {
      sectionId: name,
      name: `${name}구역`,
      shape: { kind: 'RECT', points: [[x0, y0], [x0 + SECTION_W, y0], [x0 + SECTION_W, y0 + SECTION_H], [x0, y0 + SECTION_H]] },
      label: { x: x0 + SECTION_W / 2, y: y0 - 40 },
      seatIndexRange: { from: next, to: next + count - 1 },
      seats: c,
    };
    next += count;
    return section;
  });
  return {
    format: 'peaket.seatmap.columns.v1',
    layoutVersion,
    canvas: { minX: 0, minY: 0, width, height },
    stage: [{ kind: 'RECT', points: [[width * 0.25, 60], [width * 0.75, 60], [width * 0.75, 340], [width * 0.25, 340]], name: '무대' }],
    tiers: ['tier-r', 'tier-s', 'tier-a'],
    seatCount: next,
    sections,
  };
}

/** 전체 스냅샷 이진 자료(§4.4.2, 리틀 엔디언). 매진 구역은 모두 점유, 그 밖은 11자리마다 하나 */
export function seatSnapshot(layoutVersion) {
  const total = SECTIONS.length * ROWS * PER_ROW;
  const head = 12 + SECTIONS.length * 6;
  const buf = Buffer.alloc(head + Math.ceil(total / 8));
  buf.writeUInt8(1, 0);
  buf.writeUInt8(0, 1);
  buf.writeUInt32LE(layoutVersion, 2);
  buf.writeUInt32LE(1, 6);
  buf.writeUInt16LE(SECTIONS.length, 10);
  SECTIONS.forEach((_, s) => {
    buf.writeUInt16LE(s, 12 + s * 6);
    buf.writeUInt32LE(1, 14 + s * 6);
  });
  for (let i = 0; i < total; i++) {
    const sold = Math.floor(i / (ROWS * PER_ROW)) === SOLD_OUT || i % 11 === 5;
    if (sold) buf[head + (i >> 3)] |= 1 << (i & 7);
  }
  return buf;
}

const b64u = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** 입장 토큰 모양(JWT 세 조각, jti·exp·event). 서명은 가짜다. 서명기가 jti·exp를 읽는다 */
export const mockAdmissionToken = (jti, eventId, nowMs) => `${b64u({ alg: 'ES256', typ: 'JWT' })}.${b64u({ jti, event: eventId, exp: Math.floor(nowMs / 1000) + 45 * 60 })}.${Buffer.from('mock').toString('base64url')}`;
