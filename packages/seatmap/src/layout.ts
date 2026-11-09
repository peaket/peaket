// 팬 좌석맵 파일(열 단위, docs/frontend.md §3.5·§5.2, docs/features/seat-hold.md §2 좌석 색인 규칙, BUILD_ORDER HOT-110).
// 좌석마다 객체를 두는 에디터 저장 문서(openapi SeatMapLayout)와 달리, 구역마다 열(seatId[]·x[]·y[]…)을 둔다.
// BAS-190 PoC에서 객체 배열보다 압축 전 3.4배·brotli 3.0배 작았다(tools/web-checks/seatmap/RESULT.md).
// 풀면 Worker 안 형식 배열(§3.5 'Worker 안 배열')이 된다. 좌석 색인 = 구역 순서대로 이어 붙인 위치(seatIndexRange.from부터).

export const LAYOUT_FORMAT = 'peaket.seatmap.columns.v1' as const;

/** 좌석 플래그 비트(attr 위 4비트) */
export const FLAG = { WHEELCHAIR: 1, EXCLUDED: 2 } as const;

/** 구역 65,535개 이하, 좌석 1,000,000 [가정] 이하(seat-hold §2). 델타의 seatOffset이 u16이라 구역 하나는 65,536석 이하 */
export const LIMITS = { sections: 65_535, seats: 1_000_000, seatsPerSection: 65_536, tiers: 16, canvasCm: 100_000 } as const;

export interface SeatMapShape {
  kind: 'RECT' | 'POLYGON' | 'SECTOR' | 'ARC_BAND';
  points: Array<[number, number]>;
}

export interface SeatColumns {
  seatId: string[];
  row: string[];
  number: string[];
  /** 1단위 = 1cm [가정] */
  x: number[];
  y: number[];
  /** tiers 배열의 색인 */
  tier: number[];
  /** FLAG 비트 */
  flags: number[];
}

export interface SeatMapColumnsFile {
  format: typeof LAYOUT_FORMAT;
  layoutVersion: number;
  canvas: { minX: number; minY: number; width: number; height: number };
  stage: SeatMapShape[];
  /** 등급 ID 목록(좌석 tier 열이 이 색인을 쓴다, 16개 이하) */
  tiers: string[];
  seatCount: number;
  sections: Array<{
    sectionId: string;
    name: string;
    shape: SeatMapShape;
    label: { x: number; y: number };
    seatIndexRange: { from: number; to: number };
    seats: SeatColumns;
  }>;
}

/** 풀린 좌석맵(Worker 안 배열) */
export interface DecodedLayout {
  layoutVersion: number;
  N: number;
  S: number;
  x: Float32Array;
  y: Float32Array;
  /** 아래 4비트 등급 색인, 위 4비트 플래그 */
  attr: Uint8Array;
  sectionStart: Uint32Array;
  /** 포함(마지막 좌석 색인) */
  sectionEnd: Uint32Array;
  /** 구역마다 [minX, minY, maxX, maxY] */
  bounds: Float32Array;
  /** 구역마다 좌석 ID 열(복사하지 않는다. 홀드 요청을 만들 때만 쓴다) */
  seatIds: string[][];
  file: SeatMapColumnsFile;
}

export class LayoutError extends Error {
  constructor(message: string) {
    super(`좌석맵 파일이 틀렸다: ${message}`);
    this.name = 'LayoutError';
  }
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** 열 단위 파일을 검사하고 형식 배열로 푼다. 색인 규칙(구역 순서, 빈틈 없는 범위, 열 길이)이 틀리면 LayoutError */
export function decodeLayout(file: SeatMapColumnsFile): DecodedLayout {
  if (file?.format !== LAYOUT_FORMAT) throw new LayoutError(`형식이 ${LAYOUT_FORMAT}이 아니다`);
  if (!isInt(file.layoutVersion) || file.layoutVersion < 1) throw new LayoutError('layoutVersion');
  const S = file.sections.length;
  const N = file.seatCount;
  if (S < 1 || S > LIMITS.sections) throw new LayoutError(`구역 수 ${S}`);
  if (!isInt(N) || N < 1 || N > LIMITS.seats) throw new LayoutError(`좌석 수 ${N}`);
  if (file.tiers.length < 1 || file.tiers.length > LIMITS.tiers) throw new LayoutError(`등급 수 ${file.tiers.length}`);
  // 캔버스는 한 변 1km [가정] 이하. 좌석과 도형은 캔버스 안에 있어야 한다(격자 칸 수가 끝없이 커지지 않게)
  const cv = file.canvas;
  if (![cv?.minX, cv?.minY].every(Number.isFinite) || ![cv?.width, cv?.height].every((n) => Number.isFinite(n) && n >= 1 && n <= LIMITS.canvasCm)) {
    throw new LayoutError(`canvas ${JSON.stringify(cv)}(한 변 1~${LIMITS.canvasCm}cm)`);
  }
  const inside = (px: number, py: number) => px >= cv.minX && px <= cv.minX + cv.width && py >= cv.minY && py <= cv.minY + cv.height;
  const checkShape = (name: string, points: unknown) => {
    if (!Array.isArray(points) || points.length < 3 || !points.every((p) => Array.isArray(p) && p.length === 2 && inside(p[0], p[1]))) {
      throw new LayoutError(`${name} 도형(꼭짓점 3개 이상, 캔버스 안)`);
    }
  };
  file.stage.forEach((st, i) => checkShape(`무대 ${i}`, st?.points));
  const x = new Float32Array(N);
  const y = new Float32Array(N);
  const attr = new Uint8Array(N);
  const sectionStart = new Uint32Array(S);
  const sectionEnd = new Uint32Array(S);
  const bounds = new Float32Array(S * 4);
  const seatIds: string[][] = [];
  let next = 0;
  for (let s = 0; s < S; s++) {
    const sec = file.sections[s]!;
    const { from, to } = sec.seatIndexRange;
    if (from !== next || !isInt(to) || to < from) throw new LayoutError(`${sec.sectionId}의 seatIndexRange ${from}~${to}(다음 색인 ${next}부터 빈틈 없이)`);
    const n = to - from + 1;
    if (n > LIMITS.seatsPerSection) throw new LayoutError(`${sec.sectionId} 좌석 ${n}석(구역마다 ${LIMITS.seatsPerSection} 이하)`);
    checkShape(`${sec.sectionId} 구역`, sec.shape?.points);
    const c = sec.seats;
    for (const key of ['seatId', 'row', 'number', 'x', 'y', 'tier', 'flags'] as const) {
      if (c[key]?.length !== n) throw new LayoutError(`${sec.sectionId}의 ${key} 열 길이 ${c[key]?.length} ≠ ${n}`);
    }
    sectionStart[s] = from;
    sectionEnd[s] = to;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const k = from + i;
      const px = c.x[i]!;
      const py = c.y[i]!;
      const t = c.tier[i]!;
      const fl = c.flags[i]!;
      if (!Number.isFinite(px) || !Number.isFinite(py)) throw new LayoutError(`${sec.sectionId} ${i}번째 좌석 좌표`);
      if (!inside(px, py)) throw new LayoutError(`${sec.sectionId} ${i}번째 좌석이 캔버스 밖이다(${px}, ${py})`);
      if (!isInt(t) || t < 0 || t >= file.tiers.length) throw new LayoutError(`${sec.sectionId} ${i}번째 좌석 등급 ${t}`);
      if (!isInt(fl) || fl < 0 || fl > 15) throw new LayoutError(`${sec.sectionId} ${i}번째 좌석 플래그 ${fl}`);
      if (typeof c.seatId[i] !== 'string' || c.seatId[i] === '') throw new LayoutError(`${sec.sectionId} ${i}번째 좌석 ID`);
      x[k] = px;
      y[k] = py;
      attr[k] = t | (fl << 4);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    bounds.set([minX, minY, maxX, maxY], s * 4);
    seatIds.push(c.seatId);
    next = to + 1;
  }
  if (next !== N) throw new LayoutError(`seatCount ${N} ≠ 마지막 색인 + 1(${next})`);
  return { layoutVersion: file.layoutVersion, N, S, x, y, attr, sectionStart, sectionEnd, bounds, seatIds, file };
}

/** 좌석 색인 → (구역 색인, 구역 안 거리). 델타의 seatOffset과 같다 */
export function sectionOf(L: DecodedLayout, seatIndex: number): { section: number; offset: number } {
  let lo = 0;
  let hi = L.S - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L.sectionStart[mid]! <= seatIndex) lo = mid;
    else hi = mid - 1;
  }
  return { section: lo, offset: seatIndex - L.sectionStart[lo]! };
}

/** 좌석 하나의 ID(홀드 요청을 만들 때) */
export function seatIdOf(L: DecodedLayout, seatIndex: number): string {
  const { section, offset } = sectionOf(L, seatIndex);
  return L.seatIds[section]![offset]!;
}
