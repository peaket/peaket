// 좌석 고르기(docs/verification.md §3.9 'v0-seat-hold.js'·'v0-payment.js'). 좌석 ID는 서버 seatGrid와 같은 규칙
// `<구역>-<열>-<번호>`(services/v0-monolith/src/modules/inventory/domain/inventory.ts)이고, 차례는 구역 → 열 → 번호다.

/** 홀드 좌석 고르기 방식 */
export const HOLD_MODES = Object.freeze(['spread', 'hot', 'crossed']);
/** 한 회차 좌석 상한(서버 MAX_SEATS_PER_EVENT) */
export const MAX_SEATS = 100000;

const SECTION = /^[A-Za-z0-9]{1,8}$/;

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

const unit = (u, name) => {
  if (typeof u !== 'number' || !(u >= 0 && u < 1)) throw new RangeError(`${name}는 [0, 1) 난수다: ${u}`);
  return u;
};

/**
 * 격자 좌석 수 = 구역 수 × rows × perRow. 격자가 틀리면 RangeError:
 * grid가 객체가 아님, sections가 비지 않고 겹치지 않는 `^[A-Za-z0-9]{1,8}$` 문자열 목록이 아님(대소문자는 다른 이름), rows·perRow가 1~10,000 정수가 아님, 합계가 MAX_SEATS 초과
 * @param {{ sections: string[], rows: number, perRow: number }} grid
 * @returns {number}
 */
export function seatCount(grid) {
  const { sections, rows, perRow } = grid ?? {};
  if (!Array.isArray(sections) || sections.length === 0 || !sections.every((s) => typeof s === 'string' && SECTION.test(s)) || new Set(sections).size !== sections.length) {
    throw new RangeError('구역 이름은 하나 이상이고 겹치지 않는 영숫자 1~8자다');
  }
  if (!intIn(rows, 1, 10000) || !intIn(perRow, 1, 10000)) throw new RangeError('rows·perRow는 1~10,000 정수다');
  const n = sections.length * rows * perRow;
  if (n > MAX_SEATS) throw new RangeError(`좌석은 ${MAX_SEATS}석까지다: ${n}`);
  return n;
}

/**
 * k번째 좌석 ID(0부터, 구역 → 열 → 번호 순). 0 ≤ k < seatCount(grid)인 정수가 아니면 RangeError.
 * 예: { sections: ['A','B'], rows: 2, perRow: 3 }에서 k=0 → 'A-1-1', k=3 → 'A-2-1', k=6 → 'B-1-1'
 * @param {{ sections: string[], rows: number, perRow: number }} grid
 * @param {number} k
 * @returns {string}
 */
export function seatIdAt(grid, k) {
  const n = seatCount(grid);
  if (!Number.isInteger(k) || k < 0 || k >= n) throw new RangeError(`좌석 번호는 0 이상 ${n} 미만 정수다: ${k}`);
  const perSection = grid.rows * grid.perRow;
  const s = Math.floor(k / perSection);
  const r = Math.floor((k % perSection) / grid.perRow);
  const c = k % grid.perRow;
  return `${grid.sections[s]}-${r + 1}-${c + 1}`;
}

/**
 * 결제 시나리오: 가상 사용자 i의 몫인 좌석 n개 = seatIdAt(grid, i*n) … seatIdAt(grid, i*n + n − 1).
 * n은 1~4 정수, i는 0 이상 정수, (i+1)*n ≤ seatCount(grid)가 아니면 RangeError
 * @returns {string[]}
 */
export function userSeats(grid, i, n) {
  if (!intIn(n, 1, 4)) throw new RangeError(`한 사람의 좌석 수는 1~4다: ${n}`);
  if (!Number.isInteger(i) || i < 0) throw new RangeError(`가상 사용자 번호는 0 이상 정수다: ${i}`);
  const count = seatCount(grid);
  if ((i + 1) * n > count) throw new RangeError(`좌석이 모자란다: 사용자 ${i}에 ${n}석, 모두 ${count}석`);
  return Array.from({ length: n }, (_, j) => seatIdAt(grid, i * n + j));
}

/**
 * 홀드 좌석 고르기. u1·u2는 [0, 1) 난수(시험에서 주입).
 * - spread: 열 하나를 고르게 고르고(r = floor(u1 × 구역 수 × rows)번째 열) 그 열에서 붙은 좌석 size개를 번호 오름차순으로(시작 번호 = 1 + floor(u2 × (perRow − size + 1))).
 *   size는 꼭 있어야 하고 1~4 정수이며 perRow 이하
 * - hot: 격자의 첫 hotCount석 가운데 하나(floor(u1 × hotCount)번째) 한 석. hotCount는 1 이상 정수이고 좌석 수 이하
 * - crossed: 쌍 p = floor(u2 × pairs)의 두 좌석(2p번째·2p+1번째, 열이나 구역을 건널 수 있다)을 u1 < 0.5면 [앞, 뒤], 아니면 [뒤, 앞] 순서로. pairs는 1 이상 정수이고 2 × pairs ≤ 좌석 수
 * mode가 HOLD_MODES 밖이거나 u1·u2가 [0, 1)의 수가 아니면(쓰지 않는 방식이어도) RangeError
 * @param {{ sections: string[], rows: number, perRow: number }} grid
 * @param {{ mode: string, size?: number, hotCount?: number, pairs?: number, u1: number, u2: number }} o
 * @returns {string[]}
 */
export function pickHoldSeats(grid, o) {
  const count = seatCount(grid);
  if (!HOLD_MODES.includes(o.mode)) throw new RangeError(`모르는 좌석 고르기: ${o.mode}`);
  const u1 = unit(o.u1, 'u1');
  const u2 = unit(o.u2, 'u2');
  if (o.mode === 'spread') {
    if (!intIn(o.size, 1, 4) || o.size > grid.perRow) throw new RangeError(`홀드 좌석 수는 1~4이고 한 열의 좌석 수 이하다: ${o.size}`);
    const rowsTotal = grid.sections.length * grid.rows;
    const r = Math.floor(u1 * rowsTotal);
    const start = Math.floor(u2 * (grid.perRow - o.size + 1));
    return Array.from({ length: o.size }, (_, j) => seatIdAt(grid, r * grid.perRow + start + j));
  }
  if (o.mode === 'hot') {
    if (!Number.isInteger(o.hotCount) || o.hotCount < 1 || o.hotCount > count) throw new RangeError(`인기 좌석 수는 1 이상 좌석 수 이하 정수다: ${o.hotCount}`);
    return [seatIdAt(grid, Math.floor(u1 * o.hotCount))];
  }
  if (!Number.isInteger(o.pairs) || o.pairs < 1 || 2 * o.pairs > count) throw new RangeError(`좌석 쌍 수는 1 이상이고 두 배가 좌석 수 이하다: ${o.pairs}`);
  const p = Math.floor(u2 * o.pairs);
  const a = seatIdAt(grid, 2 * p);
  const b = seatIdAt(grid, 2 * p + 1);
  return u1 < 0.5 ? [a, b] : [b, a];
}
