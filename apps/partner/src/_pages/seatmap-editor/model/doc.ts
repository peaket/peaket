// 좌석맵 문서 변환(ADR-0264 결정 4·8·12, openapi SeatMapLayout·SeatMapLayoutInput). 순수 함수만 둔다.
// 불러오기·저장 응답(SeatMapLayout) → 에디터 문서 → 저장 본문(SeatMapLayoutInput). 색인(index·seatIndexRange)과 응답 전용 칸
// (fanFilePublished·geometryLocked·warnings)은 문서에 두지 않고 본문에도 싣지 않는다(서버가 매긴다, ADR-0260 결정 3).
// 같은 문서는 늘 같은 본문이다(골든 파일 services/core-svc/test-int/fixtures/seatmap-editor/와 견준다).
import { tierErrors } from './price-tiers.ts';
import { type Arc, type EditorDoc, type FillRule, type Pt, type Seat, seatTier, type Section, type Shape, type Tier } from './types.ts';

export { seatTier };

/** 저장 본문 상한(바이트, 12MiB [가정], 서버 LAYOUT_SAVE_MAX_BYTES와 같다, ADR-0260 결정 11) */
export const SAVE_MAX_BYTES = 12 * 1024 * 1024;
/** 빈 캔버스에서 그리기의 캔버스 크기(cm) [가정](ADR-0264 결정 18) */
export const NEW_CANVAS = { width: 8_000, height: 6_000 } as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function arcOf(v: unknown): Arc | undefined {
  if (!isObj(v)) return undefined;
  const k = ['cx', 'cy', 'innerRadius', 'outerRadius', 'startAngle', 'endAngle'] as const;
  if (!k.every((x) => int(v[x]) !== undefined)) return undefined;
  return { cx: v.cx as number, cy: v.cy as number, innerRadius: v.innerRadius as number, outerRadius: v.outerRadius as number, startAngle: v.startAngle as number, endAngle: v.endAngle as number };
}

function shapeOf(v: unknown): Shape {
  const o = isObj(v) ? v : {};
  const kind = o.kind === 'RECT' || o.kind === 'SECTOR' || o.kind === 'ARC_BAND' ? o.kind : 'POLYGON';
  const points = (Array.isArray(o.points) ? o.points : []).map((p) => [Number((p as unknown[])[0]), Number((p as unknown[])[1])] as Pt);
  const name = str(o.name);
  const arc = arcOf(o.arc);
  return { kind, points, ...(name !== undefined ? { name } : {}), ...(arc ? { arc } : {}) };
}

function seatOf(v: unknown): Seat {
  const o = isObj(v) ? v : {};
  const tierId = str(o.tierId);
  const gateZone = str(o.gateZone);
  return {
    seatId: String(o.seatId ?? ''),
    row: String(o.row ?? ''),
    number: Number(o.number),
    x: Number(o.x),
    y: Number(o.y),
    ...(tierId !== undefined ? { tierId } : {}),
    ...(o.wheelchair === true ? { wheelchair: true as const } : {}),
    ...(o.unavailable === true ? { unavailable: true as const } : {}),
    ...(gateZone !== undefined ? { gateZone } : {}),
  };
}

const FILL_KEYS = ['method', 'targetCount', 'rows', 'seatsPerRow', 'rowShape', 'seatSpacingCm', 'rowSpacingCm', 'aisles', 'aisleWidthCm', 'rowLabel', 'firstNumber', 'numberFrom'] as const;

/** 채우기 규칙은 계약의 칸만 남긴다(본문 SeatFillRuleInput은 정의 밖 칸을 400으로 거절한다) */
export function cleanFillRule(v: unknown): FillRule | undefined {
  if (!isObj(v) || (v.method !== 'COUNT' && v.method !== 'GRID')) return undefined;
  const out: Obj = {};
  for (const k of FILL_KEYS) if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
  return out as unknown as FillRule;
}

function sectionOf(v: unknown): Section {
  const o = isObj(v) ? v : {};
  const level = str(o.level);
  const tierId = str(o.tierId);
  const gateZone = str(o.gateZone);
  const fillRule = cleanFillRule(o.fillRule);
  const l = isObj(o.label) ? o.label : undefined;
  const label = l && (int(l.x) !== undefined || int(l.y) !== undefined) ? { ...(int(l.x) !== undefined ? { x: l.x as number } : {}), ...(int(l.y) !== undefined ? { y: l.y as number } : {}) } : undefined;
  return {
    sectionId: String(o.sectionId ?? ''),
    name: String(o.name ?? ''),
    ...(level !== undefined ? { level } : {}),
    shape: shapeOf(o.shape),
    ...(label ? { label } : {}),
    ...(tierId !== undefined ? { tierId } : {}),
    ...(gateZone !== undefined ? { gateZone } : {}),
    ...(fillRule ? { fillRule } : {}),
    seats: (Array.isArray(o.seats) ? o.seats : []).map(seatOf),
  };
}

/** 불러오기·저장 응답·가져오기 결과의 배치 → 에디터 문서(색인과 응답 전용 칸은 버린다) */
export function docFromLayout(layout: unknown): EditorDoc {
  const o = isObj(layout) ? layout : {};
  const c = isObj(o.canvas) ? o.canvas : {};
  const sections = (Array.isArray(o.sections) ? o.sections : []).map(sectionOf);
  const tiers: Tier[] = (Array.isArray(o.priceTiers) ? o.priceTiers : []).filter(isObj).map((t) => ({ tierId: String(t.tierId), name: String(t.name), price: int(t.price) ?? null }));
  const templateVenueId = str(o.templateVenueId);
  return {
    canvas: { width: int(c.width) ?? NEW_CANVAS.width, height: int(c.height) ?? NEW_CANVAS.height },
    stage: (Array.isArray(o.stage) ? o.stage : []).map(shapeOf),
    order: sections.map((s) => s.sectionId),
    sections: Object.fromEntries(sections.map((s) => [s.sectionId, s])),
    priceTiers: tiers,
    ...(templateVenueId !== undefined ? { templateVenueId } : {}),
  };
}

/** 빈 캔버스 문서(빈 캔버스에서 그리기) */
export const emptyDoc = (): EditorDoc => ({ canvas: { ...NEW_CANVAS }, stage: [], order: [], sections: {}, priceTiers: [] });

export const sectionsInOrder = (doc: EditorDoc): Section[] => doc.order.map((id) => doc.sections[id]!).filter(Boolean);
export const seatTotal = (doc: EditorDoc): number => doc.order.reduce((n, id) => n + (doc.sections[id]?.seats.length ?? 0), 0);

function shapeBody(s: Shape): Obj {
  return { kind: s.kind, points: s.points.map(([x, y]) => [x, y]), ...(s.name !== undefined ? { name: s.name } : {}), ...(s.arc && (s.kind === 'SECTOR' || s.kind === 'ARC_BAND') ? { arc: { ...s.arc } } : {}) };
}

function seatBody(x: Seat): Obj {
  return {
    seatId: x.seatId,
    row: x.row,
    number: x.number,
    x: x.x,
    y: x.y,
    ...(x.tierId !== undefined ? { tierId: x.tierId } : {}),
    ...(x.wheelchair ? { wheelchair: true } : {}),
    ...(x.unavailable ? { unavailable: true } : {}),
    ...(x.gateZone !== undefined ? { gateZone: x.gateZone } : {}),
  };
}

/** 가격을 모두 채웠으면 그 가격 등급, 아니면 undefined(본문에 싣지 않는다. 저장은 saveBlockers가 먼저 막는다) */
const tiersBody = (tiers: readonly Tier[]): Obj[] | undefined => (tiers.every((t) => t.price !== null) ? tiers.map((t) => ({ tierId: t.tierId, name: t.name, price: t.price })) : undefined);

/**
 * 저장 본문(SeatMapLayoutInput, 닫힌 스키마). layoutVersion은 불러온 판(배치본이 없으면 0)이고 If-Match와 같다.
 * 가격 등급은 늘 보낸다(빈 목록도 보낸다. 보내지 않으면 서버가 지금 등급을 쓰는데, 에디터가 보이는 등급과 달라질 수 있다)
 */
export function saveBody(doc: EditorDoc, version: number): Obj {
  const tiers = tiersBody(doc.priceTiers);
  return {
    layoutVersion: version,
    ...(doc.templateVenueId !== undefined ? { templateVenueId: doc.templateVenueId } : {}),
    ...(tiers ? { priceTiers: tiers } : {}),
    canvas: { width: doc.canvas.width, height: doc.canvas.height },
    stage: doc.stage.map(shapeBody),
    sections: sectionsInOrder(doc).map((s) => ({
      sectionId: s.sectionId,
      name: s.name,
      ...(s.level !== undefined ? { level: s.level } : {}),
      shape: shapeBody(s.shape),
      ...(s.label ? { label: { ...s.label } } : {}),
      ...(s.tierId !== undefined ? { tierId: s.tierId } : {}),
      ...(s.gateZone !== undefined ? { gateZone: s.gateZone } : {}),
      ...(s.fillRule ? { fillRule: { ...s.fillRule } } : {}),
      seats: s.seats.map(seatBody),
    })),
  };
}

/** If-Match 값: 불러온 판(배치본이 없으면 "0") */
export const ifMatchOf = (version: number) => `"${version}"`;

/** 본문 바이트 수(UTF-8) */
export const bodyBytes = (body: unknown): number => new TextEncoder().encode(JSON.stringify(body)).length;

/** 저장을 막는 까닭(화면 검사. 서버가 다시 본다) */
export function saveBlockers(doc: EditorDoc, body?: unknown): string[] {
  const out: string[] = [];
  if (doc.priceTiers.some((t) => t.price === null)) out.push('가격을 채우지 않은 등급이 있습니다. 등급과 가격에서 가격을 넣어 주세요');
  // 이름·가격 범위·제어 문자(결정 11). 빈 가격은 위 줄이 이미 알린다(ADR-0264 결정 31)
  if (doc.priceTiers.some((t) => { const e = tierErrors(t); return e.name !== undefined || (t.price !== null && e.price !== undefined); })) out.push('가격 등급에 고칠 곳이 있습니다. 등급과 가격에서 이름과 가격을 확인해 주세요');
  if (doc.priceTiers.length > 16) out.push('가격 등급은 16개까지 둘 수 있습니다');
  if (body !== undefined && bodyBytes(body) > SAVE_MAX_BYTES) out.push('좌석맵이 너무 큽니다. 좌석이나 구역을 줄여 주세요');
  return out;
}

/** 내보내기·가져오기 파일 이름 앞부분(사용자 글자를 넣지 않는다, seat-hold ASVS 5.4.1) */
export const fileStem = (productionId: string, version: number) => `seatmap-${productionId.slice(0, 8)}-v${version}`;

/**
 * 미리보기용 팬 좌석맵 파일(openapi SeatMapColumns, core-svc fanFile과 같은 규칙: 무대 이름 포함, 라벨 기본값은 꼭짓점 평균, ADR-0264 결정 40).
 * 다른 것은 둘(결정 27): 좌석이 없는 구역은 빼고, 등급이 없으면 '-' 하나다. 좌석이 하나도 없으면 undefined
 */
export function previewColumns(doc: EditorDoc, version: number): Obj | undefined {
  const seated = sectionsInOrder(doc).filter((s) => s.seats.length > 0);
  if (seated.length === 0) return undefined;
  const tiers = doc.priceTiers.length > 0 ? doc.priceTiers.slice(0, 16).map((t) => t.tierId) : ['-'];
  const tierIndex = new Map(tiers.map((t, i) => [t, i]));
  let next = 0;
  const sections = seated.map((s) => {
    const cols = { seatId: [] as string[], row: [] as string[], number: [] as string[], x: [] as number[], y: [] as number[], tier: [] as number[], flags: [] as number[] };
    for (const x of s.seats) {
      cols.seatId.push(x.seatId);
      cols.row.push(x.row);
      cols.number.push(String(x.number));
      cols.x.push(x.x);
      cols.y.push(x.y);
      cols.tier.push(tierIndex.get(seatTier(s, x) ?? '') ?? 0);
      cols.flags.push((x.wheelchair ? 1 : 0) | (x.unavailable ? 2 : 0));
    }
    const from = next;
    next += s.seats.length;
    const pts = s.shape.points;
    const avg = (k: 0 | 1) => Math.round(pts.reduce((n, p) => n + p[k], 0) / pts.length);
    return { sectionId: s.sectionId, name: s.name, shape: { kind: s.shape.kind, points: pts.map(([x, y]) => [x, y]) }, label: { x: s.label?.x ?? avg(0), y: s.label?.y ?? avg(1) }, seatIndexRange: { from, to: next - 1 }, seats: cols };
  });
  return {
    format: 'peaket.seatmap.columns.v1',
    layoutVersion: Math.max(1, version),
    canvas: { minX: 0, minY: 0, width: Math.max(1, doc.canvas.width), height: Math.max(1, doc.canvas.height) },
    stage: doc.stage.map((s) => ({ kind: s.kind, points: s.points.map(([x, y]) => [x, y]), ...(s.name !== undefined ? { name: s.name } : {}) })),
    tiers,
    seatCount: next,
    sections,
  };
}
