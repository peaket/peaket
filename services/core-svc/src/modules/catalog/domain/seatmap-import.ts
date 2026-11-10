// 도메인 층: 좌석맵 가져오기의 상한과 받은 배치 다시 보기(docs/features/seat-hold.md §10 '받은 결과를 다시 본다', ADR-0257 결정 7·8, BUILD_ORDER HOT-210).
// 해석은 seatmap-worker가 하고(이 상수들을 함께 쓴다), core-svc는 돌려받은 배치를 그대로 믿지 않고 개수·캔버스·겹침을 다시 본다.
// 순수 함수만 둔다. 계약 스키마 검사(SeatMapLayout Zod)는 어댑터가 먼저 하고 여기로 넘긴다.

/** 한 파일의 상한(바이트, 10MB [가정]). 넘으면 413이고 작업을 부르지 않는다 */
export const SEATMAP_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** 좌석 수 상한 [가정] */
export const SEATMAP_MAX_SEATS = 50_000;
/** 구역 수 상한 [가정] */
export const SEATMAP_MAX_SECTIONS = 500;
/** 도형 하나의 꼭짓점 상한 [가정] */
export const SEATMAP_MAX_POINTS = 1_000;
/** 구역 이름 글자 수 상한 [가정](제어 문자를 지운 뒤 센다) */
export const SECTION_NAME_MAX = 30;
/** 열·번호 글자 수 상한 [가정] */
export const ROW_LABEL_MAX = 8;
/** 캔버스 한 변 상한(cm, openapi SeatMapColumns.canvas 100,000 [가정]). 정수 넘침을 막는다 */
export const SEATMAP_CANVAS_MAX = 100_000;
/** 행 오류를 싣는 상한 [가정](응답이 끝없이 커지지 않게. 작업의 오류와 다시 보기 오류를 합쳐서 센다) */
export const SEATMAP_MAX_ISSUES = 1_000;
/** 무대 도형 상한 [가정] */
export const SEATMAP_MAX_STAGE = 500;
/** 구역·좌석 ID 글자 수 상한 [가정] */
export const SEATMAP_ID_MAX = 64;
/** 등급·게이트 글자 수 상한 [가정] */
export const SEATMAP_TAG_MAX = 30;
/** 비트맵 인덱스(seatIndexRange·index)의 끝(SeatMapColumns.seatCount 상한 100만) */
export const SEATMAP_INDEX_MAX = 999_999;
/** 좌석 번호 상한(8자리) */
export const SEAT_NUMBER_MAX = 99_999_999;

export type SeatmapFormat = 'SVG' | 'JSON' | 'CSV';

export interface SeatmapIssue {
  line: number;
  field: string;
  code: string;
}

export type Point = [number, number];

export interface LayoutShape {
  kind: 'RECT' | 'POLYGON' | 'SECTOR' | 'ARC_BAND';
  points: Point[];
  name?: string;
}

export interface LayoutSeat {
  seatId: string;
  row: string;
  number: number;
  x: number;
  y: number;
  index?: number;
  tierId?: string;
  wheelchair?: boolean;
  unavailable?: boolean;
  gateZone?: string;
}

export interface LayoutSection {
  sectionId: string;
  name: string;
  level?: string;
  tierId?: string;
  gateZone?: string;
  shape: LayoutShape;
  label?: { x?: number; y?: number };
  seatIndexRange?: { from?: number; to?: number };
  seats?: LayoutSeat[];
  [k: string]: unknown;
}

/** 계약 SeatMapLayout 모양(스키마를 지난 값) */
export interface CheckedLayout {
  canvas: { width: number; height: number };
  stage?: LayoutShape[];
  sections: LayoutSection[];
  [k: string]: unknown;
}

/** 개수 상한을 넘은 이유(422 seatmap-import-rejected의 detail) */
export type TooMany = 'TOO_MANY_SEATS' | 'TOO_MANY_SECTIONS' | 'TOO_MANY_POINTS' | 'TOO_MANY_STAGE';

/**
 * 작업이 좌석 ID를 비워 둔 좌석에 `{구역 순번}-{열}-{번호}`를 채운다(ADR-0257 결정 8). 스키마 검사 전에 부르므로 모양을 모르는 값도 받는다.
 * 고친 값은 돌려준 새 값이고 받은 값은 바꾸지 않는다
 */
export function fillSeatIds(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { sections?: unknown }).sections)) return raw;
  const sections = (raw as { sections: unknown[] }).sections.map((s, si) => {
    if (typeof s !== 'object' || s === null || !Array.isArray((s as { seats?: unknown }).seats)) return s;
    const seats = (s as { seats: unknown[] }).seats.map((seat) => {
      if (typeof seat !== 'object' || seat === null || 'seatId' in seat) return seat;
      const t = seat as { row?: unknown; number?: unknown };
      return { seatId: `${si + 1}-${String(t.row)}-${String(t.number)}`, ...seat };
    });
    return { ...s, seats };
  });
  return { ...raw, sections };
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const field = (v: unknown, k: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined);

/**
 * 개수 상한을 넘었으면 그 이유. 넘지 않으면 undefined(S-T34 ⑥). 스키마 검사보다 먼저 부르므로 모양을 모르는 값도 받는다
 * (스키마에 맞지 않는 거대한 배치도 422로 거절한다, ADR-0257 결정 8)
 */
export function countRaw(raw: unknown): TooMany | undefined {
  const sections = arr(field(raw, 'sections'));
  if (sections.length > SEATMAP_MAX_SECTIONS) return 'TOO_MANY_SECTIONS';
  const stage = arr(field(raw, 'stage'));
  if (stage.length > SEATMAP_MAX_STAGE) return 'TOO_MANY_STAGE';
  let seats = 0;
  for (const s of sections) {
    seats += arr(field(s, 'seats')).length;
    if (arr(field(field(s, 'shape'), 'points')).length > SEATMAP_MAX_POINTS) return 'TOO_MANY_POINTS';
  }
  for (const s of stage) if (arr(field(s, 'points')).length > SEATMAP_MAX_POINTS) return 'TOO_MANY_POINTS';
  return seats > SEATMAP_MAX_SEATS ? 'TOO_MANY_SEATS' : undefined;
}

/** 스키마를 지난 배치의 개수 상한(countRaw와 같은 규칙) */
export function tooMany(layout: CheckedLayout): TooMany | undefined {
  return countRaw(layout);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 작업 응답의 배치 JSON 글 → 값. 읽지 못하거나 __proto__·constructor·prototype 키가 있으면 'invalid'(seat-hold ASVS 1.5.2) */
export function parseLayoutJson(text: string): unknown {
  try {
    return JSON.parse(text, (k, v: unknown) => {
      if (FORBIDDEN_KEYS.has(k)) throw new Error('원형 오염 키');
      return v;
    });
  } catch {
    return 'invalid';
  }
}

/** 캔버스 안(0 이상, 폭·높이 이하)인가 */
const inside = (c: { width: number; height: number }, x: number, y: number) => x >= 0 && y >= 0 && x <= c.width && y <= c.height;
// 작업이 지웠어야 할 제어 문자(C0·DEL·C1)와 양방향 제어 문자
const CONTROL = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const textOk = (v: string, max: number, required: boolean) => !CONTROL.test(v) && (!required || v.trim() !== '') && [...v].length <= max;
const indexOk = (v: number | undefined) => v === undefined || (Number.isSafeInteger(v) && v >= 0 && v <= SEATMAP_INDEX_MAX);

/**
 * 개수 상한 안의 배치를 다시 본다(작업 응답을 그대로 믿지 않는다, ADR-0257 결정 8): 캔버스 크기, 모든 좌표가 캔버스 안(라벨은 x·y 하나만 있어도),
 * 글자 칸(제어 문자 없음·길이), seatIndexRange·index 범위, 좌석 번호 1 이상, 같은 구역 ID와 같은 구역의 같은 열·번호 겹침, 같은 좌석 ID.
 * 구역 이름은 같아도 된다(층이 다른 같은 이름, JSON). 행 오류 목록을 돌려준다(없으면 빈 목록 = ok). 줄 번호는 모르므로 0이고 field가 자리를 가리킨다
 */
export function recheckLayout(layout: CheckedLayout): SeatmapIssue[] {
  const issues: SeatmapIssue[] = [];
  const add = (f: string, code: string) => {
    if (issues.length < SEATMAP_MAX_ISSUES) issues.push({ line: 0, field: f, code });
  };
  const text = (f: string, v: string | undefined, max: number, required = false) => {
    if (v === undefined ? required : !textOk(v, max, required)) add(f, 'TEXT_INVALID');
  };
  const c = layout.canvas;
  const canvasOk = Number.isSafeInteger(c.width) && Number.isSafeInteger(c.height) && c.width >= 1 && c.height >= 1 && c.width <= SEATMAP_CANVAS_MAX && c.height <= SEATMAP_CANVAS_MAX;
  if (!canvasOk) add('canvas', 'CANVAS_INVALID');
  const pointsOut = (pts: Point[]) => pts.some(([x, y]) => !inside(c, x, y));
  (layout.stage ?? []).forEach((s, i) => {
    text(`stage[${i}].name`, s.name, SECTION_NAME_MAX);
    if (canvasOk && pointsOut(s.points)) add(`stage[${i}]`, 'OUT_OF_CANVAS');
  });
  const seatKeys = new Set<string>();
  const seatIds = new Set<string>();
  const sectionIds = new Set<string>();
  layout.sections.forEach((s, si) => {
    const at = `sections[${si}]`;
    text(`${at}.sectionId`, s.sectionId, SEATMAP_ID_MAX, true);
    text(`${at}.name`, s.name, SECTION_NAME_MAX, true);
    text(`${at}.level`, s.level, SECTION_NAME_MAX);
    text(`${at}.tierId`, s.tierId, SEATMAP_TAG_MAX);
    text(`${at}.gateZone`, s.gateZone, SEATMAP_TAG_MAX);
    if (sectionIds.has(s.sectionId)) add(`${at}.sectionId`, 'SECTION_ID_DUPLICATE');
    sectionIds.add(s.sectionId);
    if (canvasOk && pointsOut(s.shape.points)) add(`${at}.shape`, 'OUT_OF_CANVAS');
    const l = s.label;
    if (canvasOk && l && ((l.x !== undefined && (l.x < 0 || l.x > c.width)) || (l.y !== undefined && (l.y < 0 || l.y > c.height)))) add(`${at}.label`, 'OUT_OF_CANVAS');
    const r = s.seatIndexRange;
    if (r && (!indexOk(r.from) || !indexOk(r.to) || (r.from !== undefined && r.to !== undefined && r.from > r.to))) add(`${at}.seatIndexRange`, 'RANGE_INVALID');
    (s.seats ?? []).forEach((seat, i) => {
      const st = `${at}.seats[${i}]`;
      text(`${st}.seatId`, seat.seatId, SEATMAP_ID_MAX, true);
      text(`${st}.row`, seat.row, ROW_LABEL_MAX, true);
      text(`${st}.tierId`, seat.tierId, SEATMAP_TAG_MAX);
      text(`${st}.gateZone`, seat.gateZone, SEATMAP_TAG_MAX);
      if (!Number.isSafeInteger(seat.number) || seat.number < 1 || seat.number > SEAT_NUMBER_MAX) add(`${st}.number`, 'NUMBER_INVALID');
      if (!indexOk(seat.index)) add(`${st}.index`, 'RANGE_INVALID');
      if (canvasOk && !inside(c, seat.x, seat.y)) add(st, 'OUT_OF_CANVAS');
      // 구역은 구역 ID로 가린다(JSON은 이름이 같은 구역을 받는다. CSV·SVG는 작업이 이름 겹침을 이미 오류로 낸다)
      const key = JSON.stringify([s.sectionId, seat.row, seat.number]);
      if (seatKeys.has(key)) add(st, 'DUPLICATE_SEAT');
      seatKeys.add(key);
      if (seatIds.has(seat.seatId)) add(`${st}.seatId`, 'DUPLICATE_SEAT_ID');
      seatIds.add(seat.seatId);
    });
  });
  return issues;
}

/** 좌석 수와 구역 수(기록용) */
export function layoutCounts(layout: CheckedLayout): { seats: number; sections: number } {
  return { seats: layout.sections.reduce((n, s) => n + (s.seats?.length ?? 0), 0), sections: layout.sections.length };
}

/** 압축 파일의 앞부분(gzip 1F 8B, zip 50 4B 03 04). 받지 않는다(413, seat-hold §10) */
export function isCompressed(head: Uint8Array): boolean {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return true;
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}
