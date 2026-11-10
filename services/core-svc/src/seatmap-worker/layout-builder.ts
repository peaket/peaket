// 세 형식(SVG·JSON·CSV)이 함께 쓰는 배치 모으기(docs/features/seat-hold.md §10, ADR-0257 결정 6·7).
// 해석기는 읽은 구역·무대·좌석을 여기에 넣고, 여기서 이름 정리·길이 상한·개수 상한을 한곳에서 본다.
// 개수 상한(좌석 5만·구역 500·꼭짓점 1,000 [가정])을 넘으면 그 자리에서 Rejected를 던져 해석을 멈춘다(끝까지 읽지 않는다).
import {
  ROW_LABEL_MAX,
  SEATMAP_MAX_ISSUES,
  SEATMAP_MAX_POINTS,
  SEATMAP_MAX_SEATS,
  SEATMAP_MAX_SECTIONS,
  SECTION_ID_KEY,
  SECTION_NAME_MAX,
  type LayoutShape,
  type Point,
  type SeatmapIssue,
} from '../modules/catalog/domain/seatmap-import.js';
import { charLength, cleanLabel } from './text.js';

/** 해석하지 않는다(REJECTED). code가 첫 오류 코드다 */
export class Rejected extends Error {
  constructor(
    readonly code: string,
    readonly line = 0,
    readonly field = '',
  ) {
    super(code);
  }
}

/** 무대 도형 상한 [가정] */
export const STAGE_MAX = 500;
/** 구역·좌석 ID 글자 수 상한 [가정] */
export const ID_MAX = 64;

/** 이름 붙은 무시 목록의 상한 [가정](응답이 끝없이 커지지 않게, 이름 하나는 64자까지) */
export const IGNORED_MAX = 100;
const IGNORED_NAME_MAX = 64;

export interface SeatInput {
  line: number;
  section: string;
  /** JSON처럼 좌석이 구역 안에 들어 있으면 그 구역의 차례(이름으로 찾지 않는다) */
  at?: number;
  seatId?: string;
  row: string;
  number: string;
  x: number;
  y: number;
  tierId?: string;
  wheelchair?: boolean;
  unavailable?: boolean;
  gateZone?: string;
  index?: number;
}

export interface SectionExtra {
  /** 파일이 준 구역 ID(JSON). 없으면 순번이다 */
  sectionId?: string;
  label?: { x?: number; y?: number };
  tierId?: string;
  gateZone?: string;
  level?: string;
  seatIndexRange?: { from?: number; to?: number };
  fillRule?: unknown;
}

interface BuiltSeat {
  seatId?: string;
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

/** 해석 결과의 배치(계약 SeatMapLayout 모양. 좌석 ID는 core-svc가 채운다) */
export interface ParsedLayout {
  canvas: { width: number; height: number };
  stage: LayoutShape[];
  sections: { sectionId: string; name: string; shape: LayoutShape; seats: BuiltSeat[]; [k: string]: unknown }[];
  [k: string]: unknown;
}

export class LayoutBuilder {
  readonly issues: SeatmapIssue[] = [];
  readonly #ignored = new Set<string>();
  readonly #sections: { name: string; shape: LayoutShape; extra: SectionExtra; seats: BuiltSeat[] }[] = [];
  /** 구역 차례 → 그 구역을 이름으로 찾을 수 있는가(이름 오류·겹침이면 아니다) */
  readonly #named = new Set<number>();
  readonly #byName = new Map<string, number>();
  readonly #stage: LayoutShape[] = [];
  readonly #seats: SeatInput[] = [];
  #seatCount = 0;
  /** JSON은 구역이 구역 ID로 정해지므로 이름이 같아도 된다(층이 다른 같은 이름). CSV·SVG는 이름이 곧 구역이다 */
  readonly #sameNameOk: boolean;

  constructor(o: { sameNameOk?: boolean } = {}) {
    this.#sameNameOk = o.sameNameOk === true;
  }

  issue(line: number, field: string, code: string): void {
    if (this.issues.length < SEATMAP_MAX_ISSUES) this.issues.push({ line, field, code });
  }

  /** 읽지 않고 넘긴 요소·속성 이름(값은 싣지 않는다) */
  ignore(name: string): void {
    if (this.#ignored.size < IGNORED_MAX) this.#ignored.add(name.slice(0, IGNORED_NAME_MAX));
  }

  get ignored(): string[] {
    return [...this.#ignored];
  }

  /** 꼭짓점 수 상한(넘으면 해석을 멈춘다) */
  static checkPoints(n: number, line: number, field: string): void {
    if (n > SEATMAP_MAX_POINTS) throw new Rejected('TOO_MANY_POINTS', line, field);
  }

  /** 무대 도형 하나. 500개를 넘으면 해석을 멈춘다. 이름은 다른 글자 칸처럼 정리하고 30자까지다 */
  addStage(shape: LayoutShape, line: number): void {
    if (this.#stage.length + 1 > STAGE_MAX) throw new Rejected('TOO_MANY_STAGE', line, 'stage');
    LayoutBuilder.checkPoints(shape.points.length, line, 'stage');
    const { name: rawName, ...rest } = shape;
    const name = this.#optionalLabel(rawName, line, 'name', SECTION_NAME_MAX);
    this.#stage.push(name === undefined ? rest : { ...rest, name });
  }

  /** 구역 하나. 이름이 비었거나 길거나 겹치면 행 오류다. 오류가 있어도 개수는 센다 */
  addSection(rawName: string, shape: LayoutShape, line: number, extra: SectionExtra = {}): void {
    if (this.#sections.length + 1 > SEATMAP_MAX_SECTIONS) throw new Rejected('TOO_MANY_SECTIONS', line, 'section');
    LayoutBuilder.checkPoints(shape.points.length, line, 'shape');
    const name = cleanLabel(rawName);
    if (name === '') this.issue(line, 'section', 'NAME_EMPTY');
    else if (charLength(name) > SECTION_NAME_MAX) this.issue(line, 'section', 'NAME_TOO_LONG');
    else if (this.#byName.has(name) && !this.#sameNameOk) this.issue(line, 'section', 'SECTION_DUPLICATE');
    else {
      if (!this.#byName.has(name)) this.#byName.set(name, this.#sections.length);
      this.#named.add(this.#sections.length);
    }
    const cleaned: SectionExtra = { ...extra };
    const put = (k: 'tierId' | 'gateZone' | 'level', v: string | undefined) => {
      if (v === undefined) delete cleaned[k];
      else cleaned[k] = v;
    };
    put('tierId', this.#optionalLabel(extra.tierId, line, 'tier'));
    put('gateZone', this.#optionalLabel(extra.gateZone, line, 'gate'));
    put('level', this.#optionalLabel(extra.level, line, 'level'));
    if (extra.sectionId !== undefined) {
      const id = cleanLabel(extra.sectionId);
      if (id === '' || charLength(id) > ID_MAX) {
        this.issue(line, 'sectionId', 'SECTION_ID_INVALID');
        delete cleaned.sectionId;
      } else cleaned.sectionId = id;
    }
    this.#sections.push({ name, shape, extra: cleaned, seats: [] });
  }

  /** 좌석 줄 하나를 센다(행 오류인 줄도 센다). 5만 석을 넘으면 해석을 멈춘다 */
  countSeat(line: number): void {
    this.#seatCount += 1;
    if (this.#seatCount > SEATMAP_MAX_SEATS) throw new Rejected('TOO_MANY_SEATS', line, 'seat');
  }

  /** 좌석 하나(구역 이름으로 잇는 것은 끝에서 한다) */
  addSeat(s: SeatInput): void {
    this.countSeat(s.line);
    this.#seats.push(s);
  }

  #optionalLabel(raw: string | undefined, line: number, field: string, max = SECTION_NAME_MAX): string | undefined {
    if (raw === undefined) return undefined;
    const v = cleanLabel(raw);
    if (v === '') return undefined;
    if (charLength(v) > max) {
      this.issue(line, field, `${field.toUpperCase()}_TOO_LONG`);
      return undefined;
    }
    return v;
  }

  /** 모은 것을 배치로 만든다. canvas가 없으면 모든 좌표를 담는 가장 작은 캔버스(원점부터)다 */
  finish(canvas?: { width: number; height: number }): ParsedLayout {
    for (const s of this.#seats) {
      const at = s.at !== undefined ? (this.#named.has(s.at) ? s.at : undefined) : this.#byName.get(cleanLabel(s.section));
      if (at === undefined) {
        // JSON의 좌석은 구역 안에 있다. 그 구역 이름이 틀렸으면 구역 줄이 이미 오류다
        if (s.at !== undefined) continue;
        this.issue(s.line, 'section', 'SECTION_UNKNOWN');
        continue;
      }
      const row = cleanLabel(s.row);
      if (row === '') {
        this.issue(s.line, 'row', 'ROW_EMPTY');
        continue;
      }
      if (charLength(row) > ROW_LABEL_MAX) {
        this.issue(s.line, 'row', 'ROW_TOO_LONG');
        continue;
      }
      const num = cleanLabel(s.number);
      if (!/^\d{1,8}$/.test(num) || charLength(num) > ROW_LABEL_MAX) {
        this.issue(s.line, 'number', 'NUMBER_INVALID');
        continue;
      }
      let seatId: string | undefined;
      if (s.seatId !== undefined) {
        seatId = cleanLabel(s.seatId);
        if (seatId === '' || charLength(seatId) > ID_MAX) {
          this.issue(s.line, 'seatId', 'SEAT_ID_INVALID');
          continue;
        }
      }
      const tierId = this.#optionalLabel(s.tierId, s.line, 'tier');
      const gateZone = this.#optionalLabel(s.gateZone, s.line, 'gate');
      this.#sections[at]!.seats.push({
        ...(seatId !== undefined ? { seatId } : {}),
        row,
        number: Number(num),
        x: s.x,
        y: s.y,
        ...(s.index !== undefined ? { index: s.index } : {}),
        ...(tierId !== undefined ? { tierId } : {}),
        ...(s.wheelchair !== undefined ? { wheelchair: s.wheelchair } : {}),
        ...(s.unavailable !== undefined ? { unavailable: s.unavailable } : {}),
        ...(gateZone !== undefined ? { gateZone } : {}),
      });
    }
    if (this.#sections.length === 0) this.issue(0, 'sections', 'NO_SECTIONS');
    return {
      canvas: canvas ?? this.#bounds(),
      stage: this.#stage,
      sections: this.#sections.map((s, i) => {
        const { sectionId, ...extra } = s.extra;
        // 구역 ID는 purchase-svc 판 해석의 키 조각 꼴이어야 한다. 아니면 s{구역 순번}으로 바꾼다(추천 적용 2026-11-10, ADR-0257 결정 8, ADR-0260 결정 2)
        const id = sectionId === undefined ? String(i + 1) : SECTION_ID_KEY.test(sectionId) ? sectionId : `s${i + 1}`;
        return { sectionId: id, name: s.name, shape: s.shape, ...extra, seats: s.seats };
      }),
    };
  }

  #bounds(): { width: number; height: number } {
    let w = 1;
    let h = 1;
    const see = ([x, y]: Point) => {
      if (x > w) w = x;
      if (y > h) h = y;
    };
    for (const s of this.#stage) s.points.forEach(see);
    for (const s of this.#sections) s.shape.points.forEach(see);
    for (const s of this.#seats) see([s.x, s.y]);
    return { width: w, height: h };
  }
}

/** 숫자 꼴: 겹치는 반복이 없어 되돌기가 커지지 않는다(ADR-0257 결정 5). 칸 하나는 64자까지 */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export const NUMBER_FIELD_MAX = 64;
const COORD_ABS_MAX = 10_000_000;

/** 좌표 글자 → 수(반올림 전). 64자를 넘거나 숫자가 아니거나 너무 크면 undefined */
export function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length > NUMBER_FIELD_MAX) return undefined;
  const t = raw.trim();
  if (!NUMBER.test(t)) return undefined;
  const v = Number(t);
  if (!Number.isFinite(v) || Math.abs(v) > COORD_ABS_MAX) return undefined;
  return v;
}

/** 좌표 글자 → 반올림한 정수(행 오류 COORD_INVALID는 부른 쪽) */
export function coord(raw: string | undefined): number | undefined {
  const v = num(raw);
  return v === undefined ? undefined : Math.round(v);
}
