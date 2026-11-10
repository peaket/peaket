// 좌석맵 에디터 문서 모양(docs/frontend.md §3.9, openapi SeatMapLayout, ADR-0264 결정 4).
// 구역은 ID로 찾는 표(sections)와 차례(order)로 나눠 두고, 좌석은 구역마다 배열이다. 한 번의 편집은 바뀐 구역만 새 객체로 만들고 나머지는 같이 쓴다.
// 서버가 매기는 색인(index·seatIndexRange)과 응답 전용 칸(fanFilePublished·geometryLocked·warnings)은 문서에 두지 않는다(ADR-0260 결정 3).

export type Pt = [number, number];

export type ShapeKind = 'RECT' | 'POLYGON' | 'SECTOR' | 'ARC_BAND';

/** 부채꼴·곡선 띠를 그린 원래 매개변수(openapi SeatMapShapeArc, ADR-0264 결정 12). 각도는 화면 오른쪽 0도, 시계 방향으로 는다 */
export interface Arc {
  cx: number;
  cy: number;
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
}

export interface Shape {
  kind: ShapeKind;
  /** 저장 값. 캔버스 안의 정수 꼭짓점 목록(닫힌 다각형) */
  points: Pt[];
  name?: string;
  arc?: Arc;
}

export interface Seat {
  /** 서버가 매긴 소문자 UUID, 또는 에디터·가져오기의 자리표시(서버가 새 UUIDv7로 바꾼다) */
  seatId: string;
  row: string;
  number: number;
  x: number;
  y: number;
  tierId?: string;
  wheelchair?: true;
  unavailable?: true;
  gateZone?: string;
}

/** openapi SeatFillRule(CMP-077) */
export interface FillRule {
  method: 'COUNT' | 'GRID';
  targetCount?: number;
  rows?: number;
  seatsPerRow?: number;
  rowShape?: 'STRAIGHT' | 'CURVED';
  seatSpacingCm?: number;
  rowSpacingCm?: number;
  aisles?: number;
  aisleWidthCm?: number;
  rowLabel?: 'NUMBER' | 'ALPHA';
  firstNumber?: number;
  numberFrom?: 'LEFT' | 'RIGHT';
}

export interface Section {
  sectionId: string;
  name: string;
  level?: string;
  shape: Shape;
  label?: { x?: number; y?: number };
  tierId?: string;
  gateZone?: string;
  fillRule?: FillRule;
  seats: readonly Seat[];
}

/** 가격 등급. 가져온 파일의 모르는 등급은 가격이 빈(null) 채로 더하고 채우기 전에는 저장하지 않는다(ADR-0264 결정 9) */
export interface Tier {
  tierId: string;
  name: string;
  price: number | null;
}

export interface EditorDoc {
  canvas: { width: number; height: number };
  stage: readonly Shape[];
  order: readonly string[];
  sections: Readonly<Record<string, Section>>;
  priceTiers: readonly Tier[];
  templateVenueId?: string;
}

/** 서버 오류·가져오기 오류 한 줄(openapi SeatMapImportResult.errors) */
export interface Issue {
  line: number;
  field: string;
  code: string;
}

/** 좌석의 실제 등급(좌석 tierId, 없으면 구역 tierId) */
export const seatTier = (s: Pick<Section, 'tierId'>, x: Pick<Seat, 'tierId'>): string | undefined => x.tierId ?? s.tierId;

/** 바깥 글자(구역 ID)를 키로 쓰는 표의 자기 칸만 읽는다('__proto__'·'constructor' 같은 이름이 물려받은 값을 돌려주지 않게) */
export const sectionOf = (doc: Pick<EditorDoc, 'sections'>, id: string): Section | undefined => (Object.hasOwn(doc.sections, id) ? doc.sections[id] : undefined);

/** 표에 자기 칸을 정의한다(대입하면 '__proto__'가 원형을 바꾼다) */
export function setOwn<T>(rec: Record<string, T>, key: string, value: NoInfer<T>): void {
  Object.defineProperty(rec, key, { value, writable: true, enumerable: true, configurable: true });
}
