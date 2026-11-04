// 5만 석 좌석맵 PoC의 배치 생성기(BUILD_ORDER BAS-190, wbs 0.5.4, K5, docs/frontend.md §3.5·§5.2·§6.3).
// 무대 앞에 두 줄로 놓은 직사각 구역 10개 × 50열 × 100석 = 5만 석을 만든다(v0 K5 측정과 같은 규모, loadtest/k5/seatmap-lab.mjs GRID).
// 좌표 1단위 = 1cm [가정](§3.5). 같은 입력이면 늘 같은 배치를 낸다(무작위 없음).
// 두 형식을 낸다: ① 열 단위(구역마다 seatId[]·row[]·number[]·x[]·y[]·tier[]·flags[], §5.2의 팬 좌석맵 파일 안)
// ② 객체 배열(openapi SeatMapLayout의 sections[].seats[] 꼴, 견주기용).
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export const DEFAULT_GRID = { sections: 10, rows: 50, perRow: 100 };
const SECTION_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M'];
const TIERS = ['VIP', 'R', 'S', 'A'];

/** 좌석 플래그 비트(§3.5 attr): 휠체어석, 판매 제외 */
export const FLAG = { WHEELCHAIR: 1, EXCLUDED: 2 };

/** 좌석 색인으로 정한 -5~5cm 흔들림(같은 입력이면 같은 값) */
function jitter(i, salt) {
  let h = (i * 2654435761 + salt * 40503) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  return (h % 11) - 5;
}

/** 열 단위 배치(팬 좌석맵 파일 안) */
export function generateLayout(grid = DEFAULT_GRID) {
  const { sections: S, rows: R, perRow: P } = grid;
  if (S > SECTION_IDS.length) throw new Error(`구역은 ${SECTION_IDS.length}개까지`);
  // 직사각 구역을 무대 앞에 두 줄(앞줄·뒷줄)로 놓는다. 구역 하나는 100석 × 50cm = 50m 폭, 50열 × 90cm = 45m 깊이다.
  // (부채꼴로 놓으면 안쪽 열이 100석을 좌석 간격대로 담지 못한다. 형식·크기·그리기 비용을 재는 PoC라 모양은 단순하게 둔다)
  const rowSpacing = 90; // cm(openapi SeatFillRule 기본 행 간격 [가정])
  const seatSpacing = 50; // cm(기본 좌석 간격 [가정])
  const aisle = 300; // 구역 사이 통로 3m [가정]
  const perLine = Math.ceil(S / 2);
  const secW = (P - 1) * seatSpacing;
  const secH = (R - 1) * rowSpacing;
  const totalW = perLine * secW + (perLine - 1) * aisle;
  const stage = { x: 0, y: -2500, r: 1500 }; // 무대 중심(앞줄 구역 앞 10m), 반지름 15m
  const sections = [];
  let index = 0;
  for (let s = 0; s < S; s++) {
    const id = SECTION_IDS[s];
    const line = Math.floor(s / perLine);
    const col = s % perLine;
    const x0 = -totalW / 2 + col * (secW + aisle);
    const y0 = line * (secH + aisle);
    const cols = { seatId: [], row: [], number: [], x: [], y: [], tier: [], flags: [] };
    const first = index;
    for (let r = 0; r < R; r++) {
      for (let n = 0; n < P; n++) {
        const rowName = String(r + 1);
        cols.seatId.push(`${id}-${rowName}-${n + 1}`);
        cols.row.push(rowName);
        cols.number.push(n + 1);
        // 실제 공연장 좌석은 곡선 열·단차 때문에 반듯한 격자가 아니다. 정해진 작은 흔들림(±5cm)을 넣어 압축 크기를 낙관하지 않게 한다
        cols.x.push(Math.round(x0 + n * seatSpacing + jitter(index, 1)));
        cols.y.push(Math.round(y0 + r * rowSpacing + jitter(index, 2)));
        // 앞줄 구역의 앞쪽 열이 높은 등급이다
        const depth = (line * R + r) / (2 * R);
        cols.tier.push(Math.min(TIERS.length - 1, Math.floor(depth * TIERS.length)));
        cols.flags.push(r === R - 1 && (n === 0 || n === P - 1) ? FLAG.WHEELCHAIR : 0);
        index++;
      }
    }
    const m = seatSpacing; // 도형은 좌석 둘레로 좌석 간격만큼 넓힌다
    const shape = [
      [x0 - m, y0 - m],
      [x0 + secW + m, y0 - m],
      [x0 + secW + m, y0 + secH + m],
      [x0 - m, y0 + secH + m],
    ].map(([x, y]) => [Math.round(x), Math.round(y)]);
    sections.push({
      sectionId: id,
      name: `${id}구역`,
      tierId: TIERS[line],
      shape,
      label: { x: Math.round(x0 + secW / 2), y: Math.round(y0 + secH / 2) },
      seatIndexRange: { start: first, end: index - 1 },
      seats: cols,
    });
  }
  // 캔버스: 모든 좌표를 담는 상자(원점은 무대 중심)
  const xs = sections.flatMap((s) => s.shape.map((p) => p[0]));
  const ys = sections.flatMap((s) => s.shape.map((p) => p[1]));
  const pad = 500;
  const minX = Math.min(...xs, -stage.r) - pad;
  const minY = Math.min(...ys, -stage.r) - pad;
  const maxX = Math.max(...xs, stage.r) + pad;
  const maxY = Math.max(...ys, stage.r) + pad;
  return {
    format: 'peaket.seatmap.columns.v0-poc',
    layoutVersion: 1,
    canvas: { minX, minY, width: maxX - minX, height: maxY - minY },
    stage: [{ kind: 'circle', x: stage.x, y: stage.y, r: stage.r, label: '무대' }],
    tiers: TIERS,
    seatCount: index,
    sections,
  };
}

/** 같은 배치를 openapi SeatMapLayout의 객체 배열 꼴로(견주기용) */
export function toObjectLayout(layout) {
  return {
    layoutVersion: layout.layoutVersion,
    canvas: { width: layout.canvas.width, height: layout.canvas.height },
    stage: layout.stage,
    sections: layout.sections.map(({ seats, ...sec }) => ({
      ...sec,
      tierId: sec.tierId,
      seats: seats.seatId.map((seatId, i) => ({
        seatId,
        index: sec.seatIndexRange.start + i,
        row: seats.row[i],
        number: seats.number[i],
        x: seats.x[i],
        y: seats.y[i],
        tierId: layout.tiers[seats.tier[i]],
        wheelchair: (seats.flags[i] & FLAG.WHEELCHAIR) !== 0,
      })),
    })),
  };
}

/** 문자열 하나의 크기: 압축 전, gzip(6), brotli(11, 정적 자산을 미리 압축할 때의 단계) */
export function sizes(text) {
  const buf = Buffer.from(text);
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 6 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
  };
}
