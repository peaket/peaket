// 좌석 v0의 규칙 값과 결과 형(docs/features/seat-hold.md §14). 프레임워크와 저장소를 모른다.

/** 회차 ID 형식(대기열 v0와 같다, queue-admission §13) */
export const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 좌석 ID 형식: 영숫자·-·_ 1~64자 */
export const SEAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 홀드 한 번에 고를 수 있는 좌석 수 상한(openapi HoldRequest.seatIds maxItems) */
export const MAX_SEATS_PER_HOLD = 10;
/** 홀드 TTL 기본값 7분(§5, POL-012) */
export const DEFAULT_HOLD_TTL_MS = 7 * 60 * 1000;
/** 1회 연장 기본값 3분(§5, POL-012) */
export const DEFAULT_EXTEND_MS = 3 * 60 * 1000;
/** 홀드·해제·연장·만료 트랜잭션의 문장 시간 상한(docs/architecture.md §5 시간 초과 표 핫패스 역할 1초) */
export const STATEMENT_TIMEOUT_MS = 1_000;
/** 만료 한 번에 푸는 홀드 수 상한 [가정] */
export const EXPIRE_BATCH = 500;
/** 회차 하나에 여는 좌석 수 상한 */
export const MAX_SEATS_PER_EVENT = 100_000;
/** 시각(유닉스 밀리초)의 범위: 0 ~ 9999-12-31T23:59:59.999Z */
export const MAX_EPOCH_MS = 253_402_300_799_999;

/** 좌석을 열 때의 설정(모듈 공개 함수로만 연다, §14 동작 8) */
export interface SeatEventConfig {
  /** 1인 한도(POL-011), 1~10 */
  perPersonLimit: number;
  /** 홀드 TTL(밀리초), 1초~60분. 없으면 7분 */
  holdTtlMs?: number;
  /** 1회 연장(밀리초), 1초~30분. 없으면 3분 */
  extendMs?: number;
}

/** 좌석 하나의 정의(배치 칸) */
export interface SeatDefinition {
  id: string;
  section: string;
  row: string;
  number: number;
  x: number;
  y: number;
  grade: string;
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD';

/** 좌석 목록 응답의 좌석 하나 */
export interface SeatView extends SeatDefinition {
  status: SeatStatus;
}

/** 홀드 응답(POST holds 201, 연장 200) */
export interface HoldView {
  holdId: string;
  seatIds: string[];
  /** KST 오프셋의 ISO 8601(예 2026-11-02T21:07:00.000+09:00) */
  expiresAt: string;
  extendable: boolean;
}

export type HoldResult =
  | { kind: 'held'; hold: HoldRecord }
  | { kind: 'seats-not-found' }
  | { kind: 'invalid-seat' }
  | { kind: 'seat-already-held'; seatId: string }
  | { kind: 'purchase-limit-exceeded' }
  | { kind: 'busy' };

export type ReleaseResult = { kind: 'released' } | { kind: 'already-ended' } | { kind: 'hold-not-found' } | { kind: 'busy' };

export type ExtendResult =
  | { kind: 'extended'; hold: HoldRecord }
  | { kind: 'hold-already-extended' }
  | { kind: 'hold-not-found' }
  | { kind: 'busy' };

/** 저장소가 돌려주는 홀드 한 건 */
export interface HoldRecord {
  holdId: string;
  eventId: string;
  seatIds: string[];
  expiresAtMs: number;
  extended: boolean;
}

/** 변경분 한 건(pg_notify로 나가고 WebSocket으로 그대로 보낸다, §14 동작 6) */
export interface SeatDelta {
  eventId: string;
  changes: { seatId: string; status: SeatStatus }[];
  atMs: number;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 유닉스 밀리초 → KST 오프셋의 ISO 8601(시각·타임존은 KST 고정) */
export function kstIso(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_EPOCH_MS) throw new RangeError(`시각은 유닉스 밀리초 정수다: ${String(ms)}`);
  return new Date(ms + KST_OFFSET_MS).toISOString().replace('Z', '+09:00');
}

/** 시각이 유닉스 밀리초 정수인지 */
export function isEpochMs(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_EPOCH_MS;
}

const intIn = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
// 글로 보일 칸: 1~30자, 제어 문자 없음
const LABEL = /^[^\p{Cc}\p{Cf}]{1,30}$/u;

/** 좌석 열기 설정을 검사하고 기본값을 채운다. 틀리면 던진다 */
export function normalizeSeatConfig(c: SeatEventConfig): Required<SeatEventConfig> {
  if (!intIn(c.perPersonLimit, 1, 10)) throw new RangeError('perPersonLimit은 1~10 정수다');
  const holdTtlMs = c.holdTtlMs ?? DEFAULT_HOLD_TTL_MS;
  const extendMs = c.extendMs ?? DEFAULT_EXTEND_MS;
  if (!intIn(holdTtlMs, 1_000, 60 * 60 * 1000)) throw new RangeError('holdTtlMs는 1초~60분 정수(밀리초)다');
  if (!intIn(extendMs, 1_000, 30 * 60 * 1000)) throw new RangeError('extendMs는 1초~30분 정수(밀리초)다');
  return { perPersonLimit: c.perPersonLimit, holdTtlMs, extendMs };
}

/** 열 좌석 목록을 검사한다. 틀리면 던진다 */
export function validateSeats(seats: SeatDefinition[]): void {
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS_PER_EVENT) throw new RangeError(`좌석은 1~${MAX_SEATS_PER_EVENT}석이다`);
  const ids = new Set<string>();
  for (const s of seats) {
    if (typeof s.id !== 'string' || !SEAT_ID_PATTERN.test(s.id)) throw new RangeError('좌석 ID 형식이 아니다');
    if (ids.has(s.id)) throw new RangeError(`같은 좌석 ID가 두 번 있다: ${s.id}`);
    ids.add(s.id);
    for (const label of [s.section, s.row, s.grade]) if (typeof label !== 'string' || !LABEL.test(label)) throw new RangeError(`좌석 ${s.id}의 구역·열·등급은 1~30자 글이다`);
    if (!intIn(s.number, 1, 99_999)) throw new RangeError(`좌석 ${s.id}의 번호는 1~99999 정수다`);
    if (!intIn(s.x, 0, 1_000_000) || !intIn(s.y, 0, 1_000_000)) throw new RangeError(`좌석 ${s.id}의 좌표는 0~1000000 정수다`);
  }
}

/** 시험·부하 시험용 격자 좌석 배치. 구역마다 rows × perRow 석, 구역은 가로로 늘어선다 */
export interface SeatGridOptions {
  /** 구역 이름 목록(예 ['A', 'B']) */
  sections: string[];
  rows: number;
  perRow: number;
  /** 구역 이름 → 등급(없으면 'R') */
  grades?: Record<string, string>;
  /** 좌석 간격(좌표 단위, 기본 10) */
  spacing?: number;
}

/** 좌석 ID는 `${구역}-${열}-${번호}`, 열 이름은 1부터의 수다 */
export function seatGrid(o: SeatGridOptions): SeatDefinition[] {
  const spacing = o.spacing ?? 10;
  if (!intIn(o.rows, 1, 10_000) || !intIn(o.perRow, 1, 10_000) || !intIn(spacing, 1, 1_000)) throw new RangeError('rows·perRow·spacing은 양의 정수다');
  if (!Array.isArray(o.sections) || o.sections.length === 0 || new Set(o.sections).size !== o.sections.length) throw new RangeError('구역 이름은 하나 이상이고 겹치지 않는다');
  if (o.sections.length * o.rows * o.perRow > MAX_SEATS_PER_EVENT) throw new RangeError(`좌석은 ${MAX_SEATS_PER_EVENT}석까지다`);
  const sectionWidth = o.perRow * spacing + spacing * 2;
  const out: SeatDefinition[] = [];
  o.sections.forEach((name, si) => {
    for (let r = 1; r <= o.rows; r += 1) {
      for (let n = 1; n <= o.perRow; n += 1) {
        out.push({ id: `${name}-${r}-${n}`, section: name, row: String(r), number: n, x: si * sectionWidth + (n - 1) * spacing, y: (r - 1) * spacing, grade: o.grades?.[name] ?? 'R' });
      }
    }
  });
  return out;
}
