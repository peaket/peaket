// @ts-check
// v0 좌석맵의 상태와 그리기(docs/features/seat-hold.md §14 동작 7, K5의 v0).
// 좌석 객체 배열 하나를 메인 스레드에서 Canvas 2D 한 장에 좌석마다 따로 그린다(Worker·TypedArray·묶어 그리기 없음).
// DOM을 모르는 순수 함수라 시험(Node)에서 바로 부른다. 그리기 대상은 Canvas 2D 문맥의 일부 모양만 쓴다.

/** @typedef {'AVAILABLE' | 'HELD' | 'SOLD'} SeatStatus */
/** @typedef {{ id: string, section: string, row: string, number: number, x: number, y: number, grade: string, status: SeatStatus }} Seat */
/** @typedef {{ seats: Seat[], byId: Map<string, Seat> }} SeatModel */
/** @typedef {{ scale: number, offsetX: number, offsetY: number }} View 화면 좌표 = 좌석 좌표 × scale + offset */
/**
 * @typedef {object} Ctx2D Canvas 2D 문맥에서 쓰는 부분
 * @property {(x: number, y: number, w: number, h: number) => void} clearRect
 * @property {() => void} beginPath
 * @property {(x: number, y: number, r: number, a0: number, a1: number) => void} arc
 * @property {(x: number, y: number, w: number, h: number) => void} rect
 * @property {() => void} fill
 * @property {() => void} stroke
 * @property {unknown} fillStyle
 * @property {unknown} strokeStyle
 * @property {number} lineWidth
 */

/** 한 번에 고를 수 있는 좌석 수(홀드 한 번의 상한과 같다) */
export const MAX_SELECT = 10;
/** 좌석 원의 반지름(좌석 좌표 단위) */
export const SEAT_RADIUS = 4;
/** 확대 배율의 범위 */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 20;
/** 등급 색(빈 좌석). 없는 등급은 DEFAULT_GRADE_COLOR */
export const GRADE_COLORS = /** @type {Record<string, string>} */ ({ VIP: '#7c3aed', R: '#dc2626', S: '#2563eb', A: '#059669' });
export const DEFAULT_GRADE_COLOR = '#0f766e';
export const HELD_COLOR = '#9ca3af';
export const SOLD_COLOR = '#374151';
/** 고른 좌석·내 홀드 테두리 */
export const OUTLINE_COLOR = '#111827';
const STATUSES = new Set(['AVAILABLE', 'HELD', 'SOLD']);

/**
 * 좌석 목록 응답으로 좌석 객체 배열과 ID 찾기 표를 만든다(받은 배열을 바꾸지 않는다)
 * @param {Seat[]} seats
 * @returns {SeatModel}
 */
export function createSeatModel(seats) {
  const list = seats.map((s) => ({ ...s }));
  return { seats: list, byId: new Map(list.map((s) => [s.id, s])) };
}

/**
 * 변경분을 반영한다. 모르는 좌석과 모르는 상태는 건너뛴다
 * @param {SeatModel} model
 * @param {{ seatId: string, status: string }[]} changes
 * @returns {number} 상태가 실제로 바뀐 좌석 수
 */
export function applyChanges(model, changes) {
  let n = 0;
  for (const c of changes) {
    const seat = model.byId.get(c.seatId);
    if (!seat || !STATUSES.has(c.status) || seat.status === c.status) continue;
    seat.status = /** @type {SeatStatus} */ (c.status);
    n += 1;
  }
  return n;
}

/**
 * 모든 좌석이 화면(가로 width, 세로 height)에 여백 padding을 두고 들어오는 보기. 좌석이 없으면 배율 1, 이동 0
 * @param {SeatModel} model
 * @param {number} width
 * @param {number} height
 * @param {number} [padding]
 * @returns {View}
 */
export function fitView(model, width, height, padding = 20) {
  if (model.seats.length === 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of model.seats) {
    minX = Math.min(minX, s.x - SEAT_RADIUS);
    minY = Math.min(minY, s.y - SEAT_RADIUS);
    maxX = Math.max(maxX, s.x + SEAT_RADIUS);
    maxY = Math.max(maxY, s.y + SEAT_RADIUS);
  }
  const innerW = Math.max(width - 2 * padding, 1);
  const innerH = Math.max(height - 2 * padding, 1);
  const w = maxX - minX;
  const h = maxY - minY;
  const scale = Math.min(innerW / w, innerH / h);
  return { scale, offsetX: padding + (innerW - w * scale) / 2 - minX * scale, offsetY: padding + (innerH - h * scale) / 2 - minY * scale };
}

/**
 * 화면 점 (px, py)를 고정한 채 factor배 확대·축소한다. 배율은 MIN_SCALE~MAX_SCALE로 자른다
 * @param {View} view
 * @param {number} factor
 * @param {number} px
 * @param {number} py
 * @returns {View}
 */
export function zoomAt(view, factor, px, py) {
  // 맞춤 배율이 범위 밖이어도 축소는 더 작게, 확대는 더 크게만 한다(범위로 자르면 방향이 뒤집힌다, 새 맥락 리뷰)
  const wanted = view.scale * factor;
  const scale = factor < 1 ? Math.min(view.scale, Math.max(MIN_SCALE, wanted)) : Math.max(view.scale, Math.min(MAX_SCALE, wanted));
  const k = scale / view.scale;
  return { scale, offsetX: px - (px - view.offsetX) * k, offsetY: py - (py - view.offsetY) * k };
}

/**
 * 화면 좌표로 dx·dy만큼 옮긴다
 * @param {View} view
 * @param {number} dx
 * @param {number} dy
 * @returns {View}
 */
export function panBy(view, dx, dy) {
  return { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

/**
 * 화면 점 (px, py)에 있는 좌석. 좌석 중심과의 화면 거리가 max(SEAT_RADIUS × scale, 6) 이하인 것 가운데 가장 가까운 좌석
 * @param {SeatModel} model
 * @param {View} view
 * @param {number} px
 * @param {number} py
 * @returns {Seat | undefined}
 */
export function seatAt(model, view, px, py) {
  const reach = Math.max(SEAT_RADIUS * view.scale, 6);
  /** @type {Seat | undefined} */
  let best;
  let bestD = Infinity;
  for (const s of model.seats) {
    const d = Math.hypot(s.x * view.scale + view.offsetX - px, s.y * view.scale + view.offsetY - py);
    if (d <= reach && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * 좌석을 고르거나 고르기를 푼다. 빈 좌석만 고를 수 있고 MAX_SELECT를 넘지 않는다. 고른 집합을 바꾼다
 * @param {Set<string>} selected
 * @param {Seat} seat
 * @returns {'selected' | 'unselected' | 'unavailable' | 'limit'}
 */
export function toggleSelection(selected, seat) {
  if (selected.has(seat.id)) {
    selected.delete(seat.id);
    return 'unselected';
  }
  if (seat.status !== 'AVAILABLE') return 'unavailable';
  if (selected.size >= MAX_SELECT) return 'limit';
  selected.add(seat.id);
  return 'selected';
}

/**
 * 고른 좌석 가운데 더는 빈 좌석이 아닌 것을 뺀다(다른 분이 잡은 변경분이 왔을 때)
 * @param {SeatModel} model
 * @param {Set<string>} selected
 * @returns {string[]} 뺀 좌석 ID
 */
export function pruneSelection(model, selected) {
  /** @type {string[]} */
  const dropped = [];
  for (const id of [...selected]) {
    const seat = model.byId.get(id);
    if (!seat || seat.status !== 'AVAILABLE') {
      selected.delete(id);
      dropped.push(id);
    }
  }
  return dropped;
}

/**
 * 누른 점(뷰포트 좌표)을 캔버스 좌표로 바꾼다. 캔버스가 CSS로 줄거나 늘어 보여도(좁은 화면) 그리는 좌표와 맞춘다
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ left: number, top: number, width: number, height: number }} rect 캔버스의 getBoundingClientRect()
 * @param {number} width 캔버스 width(그리는 좌표의 폭)
 * @param {number} height 캔버스 height
 * @returns {{ x: number, y: number }}
 */
export function canvasPoint(clientX, clientY, rect, width, height) {
  return { x: ((clientX - rect.left) * width) / rect.width, y: ((clientY - rect.top) * height) / rect.height };
}

/**
 * 좌석을 모두 그린다(좌석마다 경로 하나, 묶어 그리기 없음). 빈 좌석은 등급 색 원, 다른 분 선택은 회색 원,
 * 판매는 짙은 회색 사각형, 고른 좌석은 굵은 테두리(lineWidth 3), 내 홀드는 이중 테두리(테두리 두 번)
 * @param {Ctx2D} ctx
 * @param {SeatModel} model
 * @param {View} view
 * @param {{ selected: Set<string>, mine: Set<string>, width: number, height: number }} o
 * @returns {number} 그린 좌석 수(화면 밖 좌석도 그린다)
 */
export function drawSeatMap(ctx, model, view, o) {
  ctx.clearRect(0, 0, o.width, o.height);
  const r = Math.max(SEAT_RADIUS * view.scale, 1.5);
  let n = 0;
  for (const s of model.seats) {
    const x = s.x * view.scale + view.offsetX;
    const y = s.y * view.scale + view.offsetY;
    const isMine = o.mine.has(s.id);
    ctx.beginPath();
    if (s.status === 'SOLD' && !isMine) {
      ctx.rect(x - r, y - r, 2 * r, 2 * r);
      ctx.fillStyle = SOLD_COLOR;
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = s.status === 'HELD' && !isMine ? HELD_COLOR : (GRADE_COLORS[s.grade] ?? DEFAULT_GRADE_COLOR);
    }
    ctx.fill();
    if (o.selected.has(s.id)) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.stroke();
    }
    if (isMine) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    n += 1;
  }
  return n;
}
