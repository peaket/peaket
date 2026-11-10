// ③ 좌석 다듬기 계산(ADR-0264 결정 7, d5 §6.5 ③). 순수 함수이고 에디터 Worker·저장소 명령이 부른다. 고른 것은 좌석 ID 집합이다.
// - 줄 맞추기: 행마다(구역·열) 그 행의 첫·끝 좌석(번호 차례)을 잇는 직선 위로 고른 좌석을 옮긴다(첫·끝 좌석은 그대로).
// - 간격 고르게: 행마다 고른 좌석을 고른 것의 첫·끝 사이에 같은 간격으로 둔다(번호 차례, 셋 이상일 때).
// - 통로 만들기·지우기: 고른 좌석을 지운다. 양쪽 좌석과 번호는 그대로다.
// - 좌석 넣기: 누른 자리에 가장 가까운 행의 좌석으로 넣고 번호는 그 행의 가장 큰 번호 + 1.
// - 번호 다시 매기기: 고른 좌석이 있는 행마다 결정 6의 차례(무대를 보고 왼쪽·오른쪽, 통로를 건너 이어)로 첫 번호부터 다시 센다.
// - 옮기기: 끌기와 화살표 10cm·Shift+화살표 1m. 캔버스 밖으로 나가지 않는다(모두 같은 만큼 덜 옮긴다).
import { FILL_DEFAULTS, frameOf, sideOf } from './fill.ts';
import { type EditorDoc, type Pt, type Seat, type Section, sectionOf, setOwn } from './types.ts';

type Ids = ReadonlySet<string>;

/** 바뀐 구역만(나머지는 같은 객체) */
export type SectionChanges = Record<string, Section>;

const rowKey = (row: string) => row;

/** 고른 좌석이 든 구역 */
function touched(doc: EditorDoc, ids: Ids): Section[] {
  return doc.order.map((id) => doc.sections[id]!).filter((s) => s.seats.some((x) => ids.has(x.seatId)));
}

/** 같은 열 좌석들(배열 차례 그대로) */
function rowsOf(seats: readonly Seat[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  seats.forEach((x, i) => {
    const k = rowKey(x.row);
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  });
  return m;
}

const byNumber = (seats: readonly Seat[]) => (a: number, b: number) => seats[a]!.number - seats[b]!.number;

/** 좌석 옮기기(같은 만큼, 캔버스 안에서 덜 옮긴다). 실제로 옮긴 양도 돌려준다 */
export function moveSeats(doc: EditorDoc, ids: Ids, dx: number, dy: number): { changes: SectionChanges; dx: number; dy: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of touched(doc, ids)) {
    for (const x of s.seats) {
      if (!ids.has(x.seatId)) continue;
      minX = Math.min(minX, x.x);
      minY = Math.min(minY, x.y);
      maxX = Math.max(maxX, x.x);
      maxY = Math.max(maxY, x.y);
    }
  }
  if (minX === Infinity) return { changes: {}, dx: 0, dy: 0 };
  const mx = Math.round(Math.min(Math.max(dx, -minX), doc.canvas.width - maxX));
  const my = Math.round(Math.min(Math.max(dy, -minY), doc.canvas.height - maxY));
  if (mx === 0 && my === 0) return { changes: {}, dx: 0, dy: 0 };
  const changes: SectionChanges = {};
  for (const s of touched(doc, ids)) setOwn(changes, s.sectionId, { ...s, seats: s.seats.map((x) => (ids.has(x.seatId) ? { ...x, x: x.x + mx, y: x.y + my } : x)) });
  return { changes, dx: mx, dy: my };
}

/** 줄 맞추기 */
export function alignRows(doc: EditorDoc, ids: Ids): SectionChanges {
  const changes: SectionChanges = {};
  for (const s of touched(doc, ids)) {
    const seats = [...s.seats];
    let changed = false;
    for (const idx of rowsOf(s.seats).values()) {
      if (!idx.some((i) => ids.has(s.seats[i]!.seatId))) continue;
      const sorted = [...idx].sort(byNumber(s.seats));
      const a = s.seats[sorted[0]!]!;
      const b = s.seats[sorted.at(-1)!]!;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      if (len2 === 0) continue;
      for (const i of sorted.slice(1, -1)) {
        const x = s.seats[i]!;
        if (!ids.has(x.seatId)) continue;
        const t = ((x.x - a.x) * vx + (x.y - a.y) * vy) / len2;
        const nx = Math.round(a.x + t * vx);
        const ny = Math.round(a.y + t * vy);
        if (nx !== x.x || ny !== x.y) {
          seats[i] = { ...x, x: nx, y: ny };
          changed = true;
        }
      }
    }
    if (changed) setOwn(changes, s.sectionId, { ...s, seats });
  }
  return changes;
}

/** 간격 고르게 */
export function distributeRows(doc: EditorDoc, ids: Ids): SectionChanges {
  const changes: SectionChanges = {};
  for (const s of touched(doc, ids)) {
    const seats = [...s.seats];
    let changed = false;
    for (const idx of rowsOf(s.seats).values()) {
      const picked = idx.filter((i) => ids.has(s.seats[i]!.seatId)).sort(byNumber(s.seats));
      if (picked.length < 3) continue;
      const a = s.seats[picked[0]!]!;
      const b = s.seats[picked.at(-1)!]!;
      const n = picked.length - 1;
      picked.forEach((i, k) => {
        if (k === 0 || k === n) return;
        const x = s.seats[i]!;
        const nx = Math.round(a.x + ((b.x - a.x) * k) / n);
        const ny = Math.round(a.y + ((b.y - a.y) * k) / n);
        if (nx !== x.x || ny !== x.y) {
          seats[i] = { ...x, x: nx, y: ny };
          changed = true;
        }
      });
    }
    if (changed) setOwn(changes, s.sectionId, { ...s, seats });
  }
  return changes;
}

/** 지우기·통로 만들기: 고른 좌석을 지운다(번호는 그대로) */
export function removeSeats(doc: EditorDoc, ids: Ids): SectionChanges {
  const changes: SectionChanges = {};
  for (const s of touched(doc, ids)) setOwn(changes, s.sectionId, { ...s, seats: s.seats.filter((x) => !ids.has(x.seatId)) });
  return changes;
}

/** 번호 다시 매기기 */
export function renumberRows(doc: EditorDoc, ids: Ids): SectionChanges {
  const changes: SectionChanges = {};
  for (const s of touched(doc, ids)) {
    const rule = s.fillRule ?? { method: 'COUNT' as const };
    const shapeKind = rule.rowShape ?? FILL_DEFAULTS.rowShape;
    const from = rule.numberFrom ?? FILL_DEFAULTS.numberFrom;
    const first = rule.firstNumber ?? FILL_DEFAULTS.firstNumber;
    const f = frameOf(s.shape.points, doc.stage, doc.canvas);
    const seats = [...s.seats];
    let changed = false;
    for (const idx of rowsOf(s.seats).values()) {
      if (!idx.some((i) => ids.has(s.seats[i]!.seatId))) continue;
      const order = [...idx].sort((a, b) => {
        const sa = sideOf(f, shapeKind, s.seats[a]!.x, s.seats[a]!.y);
        const sb = sideOf(f, shapeKind, s.seats[b]!.x, s.seats[b]!.y);
        return from === 'LEFT' ? sa - sb || a - b : sb - sa || a - b;
      });
      order.forEach((i, k) => {
        if (s.seats[i]!.number !== first + k) {
          seats[i] = { ...s.seats[i]!, number: first + k };
          changed = true;
        }
      });
    }
    if (changed) setOwn(changes, s.sectionId, { ...s, seats });
  }
  return changes;
}

/** 좌석 넣기: 누른 자리(캔버스 안으로)에 가장 가까운 행의 좌석. 좌석이 없는 구역은 1열 첫 번호 */
export function insertSeat(doc: EditorDoc, sectionId: string, p: Pt, seatId: string): { changes: SectionChanges; seat: Seat } | undefined {
  const s = sectionOf(doc, sectionId);
  if (!s) return undefined;
  const x = Math.min(doc.canvas.width, Math.max(0, Math.round(p[0])));
  const y = Math.min(doc.canvas.height, Math.max(0, Math.round(p[1])));
  if (s.seats.length === 0) {
    const seat: Seat = { seatId, row: '1', number: s.fillRule?.firstNumber ?? FILL_DEFAULTS.firstNumber, x, y };
    return { changes: { [sectionId]: { ...s, seats: [seat] } }, seat };
  }
  // 행까지의 거리: 번호 차례로 이은 좌석 꺾은선까지(통로 자리를 눌러도 그 행으로 넣는다)
  let row = s.seats[0]!.row;
  let bestD = Infinity;
  for (const idx of rowsOf(s.seats).values()) {
    const line = [...idx].sort(byNumber(s.seats)).map((i) => s.seats[i]!);
    let d = Infinity;
    for (let k = 0; k < line.length; k++) {
      const a = line[k]!;
      const b = line[Math.min(k + 1, line.length - 1)]!;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / len2));
      d = Math.min(d, Math.hypot(x - (a.x + t * vx), y - (a.y + t * vy)));
    }
    if (d < bestD) {
      bestD = d;
      row = line[0]!.row;
    }
  }
  let max = -Infinity;
  let last = -1;
  s.seats.forEach((q, i) => {
    if (q.row !== row) return;
    max = Math.max(max, q.number);
    last = i;
  });
  const seat: Seat = { seatId, row, number: max + 1, x, y };
  const seats = [...s.seats.slice(0, last + 1), seat, ...s.seats.slice(last + 1)];
  return { changes: { [sectionId]: { ...s, seats } }, seat };
}

/** 좌석 속성 바꾸기(잠긴 배치본에서는 판매 제외·휠체어석·게이트만, ADR-0264 결정 13) */
export interface SeatPatch {
  tierId?: string | null;
  wheelchair?: boolean;
  unavailable?: boolean;
  gateZone?: string | null;
}

export function patchSeats(doc: EditorDoc, ids: Ids, patch: SeatPatch): SectionChanges {
  const apply = (x: Seat): Seat => {
    const out: Seat = { ...x };
    if (patch.tierId !== undefined) {
      if (patch.tierId === null) delete out.tierId;
      else out.tierId = patch.tierId;
    }
    if (patch.gateZone !== undefined) {
      if (patch.gateZone === null) delete out.gateZone;
      else out.gateZone = patch.gateZone;
    }
    if (patch.wheelchair !== undefined) {
      if (patch.wheelchair) out.wheelchair = true;
      else delete out.wheelchair;
    }
    if (patch.unavailable !== undefined) {
      if (patch.unavailable) out.unavailable = true;
      else delete out.unavailable;
    }
    return out;
  };
  const changes: SectionChanges = {};
  for (const s of touched(doc, ids)) setOwn(changes, s.sectionId, { ...s, seats: s.seats.map((x) => (ids.has(x.seatId) ? apply(x) : x)) });
  return changes;
}

/** 상자(세계 좌표) 안의 좌석 ID. 구역 도형 상자로 먼저 거른다 */
export function seatsInBox(doc: EditorDoc, box: { minX: number; minY: number; maxX: number; maxY: number }): string[] {
  const out: string[] = [];
  for (const id of doc.order) {
    const s = doc.sections[id]!;
    for (const x of s.seats) if (x.x >= box.minX && x.x <= box.maxX && x.y >= box.minY && x.y <= box.maxY) out.push(x.seatId);
  }
  return out;
}

/** 그 좌석의 행 전체(행 고르기) */
export function rowSeatIds(doc: EditorDoc, seatId: string): string[] {
  for (const id of doc.order) {
    const s = doc.sections[id]!;
    const hit = s.seats.find((x) => x.seatId === seatId);
    if (hit) return s.seats.filter((x) => x.row === hit.row).map((x) => x.seatId);
  }
  return [];
}

/** 좌석 ID → (구역, 배열 위치) */
export function locateSeats(doc: EditorDoc): Map<string, { sectionId: string; i: number }> {
  const m = new Map<string, { sectionId: string; i: number }>();
  for (const id of doc.order) doc.sections[id]!.seats.forEach((x, i) => m.set(x.seatId, { sectionId: id, i }));
  return m;
}
