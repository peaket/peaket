// @ts-check
// v0 좌석맵 화면 잇기(docs/features/seat-hold.md §14 동작 7): 좌석 목록 받기, 변경분 WebSocket, Canvas 조작, 홀드·놓기·연장.
// 서버 값과 오류 문구는 textContent로만 넣는다(asvs/v0-baseline.md 3.2.2).
import {
  MAX_SELECT,
  applyChanges,
  canvasPoint,
  createSeatModel,
  drawSeatMap,
  fitView,
  panBy,
  pruneSelection,
  seatAt,
  toggleSelection,
  zoomAt,
} from './seatmap-model.js';

/** @typedef {import('./seatmap-model.js').SeatModel} SeatModel */
/** @typedef {import('./seatmap-model.js').View} View */
/** @typedef {{ holdId: string, seatIds: string[], expiresAt: string, extendable: boolean }} Hold */

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const canvas = /** @type {HTMLCanvasElement} */ (el('map'));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const statusEl = el('status');
const connEl = el('conn');
const selectionEl = el('selection');
const timerEl = el('timer');
const holdBtn = /** @type {HTMLButtonElement} */ (el('hold'));
const extendBtn = /** @type {HTMLButtonElement} */ (el('extend'));
const releaseBtn = /** @type {HTMLButtonElement} */ (el('release'));

const eventId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
el('event').textContent = eventId;
const api = `/v1/events/${encodeURIComponent(eventId)}`;
/** v0에만 있는 좌석 목록·변경분 경로(docs/features/seat-hold.md §14 동작 1·6) */
const v0api = `/v0/events/${encodeURIComponent(eventId)}`;

/** @type {SeatModel | undefined} */
let model;
/** @type {View} */
let view = { scale: 1, offsetX: 0, offsetY: 0 };
/** @type {Set<string>} */
const selected = new Set();
/** @type {Set<string>} */
let mine = new Set();
/** @type {Hold | undefined} */
let hold;

/** @param {string} msg */
const say = (msg) => {
  statusEl.textContent = msg;
};

/**
 * Problem 본문의 제목(없으면 상태 코드)
 * @param {Response} res
 */
async function problemText(res) {
  try {
    const body = await res.json();
    if (body && typeof body.title === 'string') return `${body.title} (${res.status})`;
  } catch {
    // 본문이 JSON이 아니다
  }
  return `요청이 실패했습니다 (${res.status})`;
}

function redraw() {
  if (!model) return;
  drawSeatMap(ctx, model, view, { selected, mine, width: canvas.width, height: canvas.height });
  renderPanel();
}

function renderPanel() {
  selectionEl.textContent = selected.size === 0 ? '고른 좌석이 없습니다' : `고른 좌석 ${selected.size}개: ${[...selected].join(', ')}`;
  holdBtn.disabled = selected.size === 0 || hold !== undefined;
  extendBtn.hidden = hold === undefined || !hold.extendable;
  releaseBtn.hidden = hold === undefined;
}

/**
 * 같은 출처 요청. 네트워크 오류는 상태 줄에 알리고 undefined
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function call(url, init = {}) {
  try {
    return await fetch(url, { credentials: 'same-origin', ...init });
  } catch {
    say('서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요');
    return undefined;
  }
}

async function loadSeats() {
  const res = await call(`${v0api}/seats`);
  if (!res) return false;
  if (!res.ok) {
    say(await problemText(res));
    return false;
  }
  const body = await res.json();
  model = createSeatModel(body.seats);
  if (view.scale === 1 && view.offsetX === 0 && view.offsetY === 0) view = fitView(model, canvas.width, canvas.height);
  pruneSelection(model, selected);
  redraw();
  return true;
}

// 다시 연결: 간격을 늘려(3초부터 30초까지, 위로만 0~20% 흔들기) 다시 한다. 간격은 연결이 열렸을 때만 되돌린다(새 맥락 리뷰·2차 리뷰)
let retryMs = 3000;
function reconnectLater() {
  const wait = retryMs * (1 + Math.random() * 0.2);
  connEl.textContent = `연결이 끊겼습니다. ${Math.round(wait / 1000)}초 뒤 다시 연결합니다`;
  retryMs = Math.min(retryMs * 2, 30000);
  setTimeout(() => connect(), wait);
}

// 연결을 먼저 열고, 열린 뒤 좌석 목록을 받는다. 목록을 받는 동안 온 변경분은 모아 두었다가 목록 뒤에 적용한다
// (목록 → 연결 순서면 그 사이의 변경분을 잃는다, 2차 리뷰. 상태 값은 절대값이라 다시 적용해도 된다)
function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}${v0api}/seat-deltas`);
  /** @type {{ seatId: string, status: string }[][] | undefined} 목록을 받는 동안 모은 변경분 */
  let pending = [];
  /** @param {{ seatId: string, status: string }[]} changes */
  const apply = (changes) => {
    if (!model) return;
    applyChanges(model, changes);
    const dropped = pruneSelection(model, selected);
    if (dropped.length > 0) say(`다른 분이 먼저 고른 좌석을 선택에서 뺐습니다: ${dropped.join(', ')}`);
    redraw();
  };
  ws.addEventListener('open', () => {
    retryMs = 3000;
    void loadSeats().then((ok) => {
      if (!ok) {
        ws.close();
        return;
      }
      const queued = pending ?? [];
      pending = undefined;
      for (const changes of queued) apply(changes);
      connEl.textContent = '실시간 연결됨';
    });
  });
  ws.addEventListener('message', (e) => {
    const delta = JSON.parse(String(e.data));
    if (delta.eventId !== eventId || !Array.isArray(delta.changes)) return;
    if (pending) pending.push(delta.changes);
    else apply(delta.changes);
  });
  ws.addEventListener('close', () => reconnectLater());
}

// 조작: 누르기(고르기), 휠(확대), 끌기(이동)
// 캔버스가 CSS로 줄어 보이면(좁은 화면) 누른 위치를 캔버스 좌표로 바꾼다(브라우저 확인에서 찾음)
/** @param {MouseEvent} e */
const at = (e) => {
  // 테두리를 뺀 그림 영역 기준(clientLeft·clientWidth, 2차 리뷰)
  const r = canvas.getBoundingClientRect();
  const inner = { left: r.left + canvas.clientLeft, top: r.top + canvas.clientTop, width: canvas.clientWidth || r.width, height: canvas.clientHeight || r.height };
  return canvasPoint(e.clientX, e.clientY, inner, canvas.width, canvas.height);
};
let drag = /** @type {{ x: number, y: number, moved: boolean } | undefined} */ (undefined);
canvas.addEventListener('pointerdown', (e) => {
  const p = at(e);
  drag = { x: p.x, y: p.y, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = at(e);
  const dx = p.x - drag.x;
  const dy = p.y - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag = { x: p.x, y: p.y, moved: true };
  view = panBy(view, dx, dy);
  redraw();
});
canvas.addEventListener('pointerup', (e) => {
  const wasDrag = drag?.moved;
  drag = undefined;
  if (wasDrag || !model) return;
  const p = at(e);
  const seat = seatAt(model, view, p.x, p.y);
  if (!seat) return;
  if (hold) {
    say('이미 잡은 좌석이 있습니다. 놓은 뒤에 다시 고르세요');
    return;
  }
  const r = toggleSelection(selected, seat);
  if (r === 'unavailable') say(`${seat.id}은 고를 수 없는 좌석입니다`);
  else if (r === 'limit') say(`좌석은 ${MAX_SELECT}개까지 고를 수 있습니다`);
  else say(r === 'selected' ? `${seat.id}을 골랐습니다` : `${seat.id} 고르기를 풀었습니다`);
  redraw();
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.deltaY === 0) return; // 가로 밀기는 확대가 아니다
    const p = at(e);
    view = zoomAt(view, e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
    redraw();
  },
  { passive: false },
);

holdBtn.addEventListener('click', async () => {
  holdBtn.disabled = true;
  const res = await call(`${api}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seatIds: [...selected] }),
  });
  if (!res) {
    renderPanel();
    return;
  }
  if (res.status !== 201) {
    say(await problemText(res));
    renderPanel();
    return;
  }
  hold = /** @type {Hold} */ (await res.json());
  mine = new Set(hold.seatIds);
  selected.clear();
  say(`좌석 ${hold.seatIds.length}개를 잡았습니다`);
  redraw();
});

releaseBtn.addEventListener('click', async () => {
  if (!hold) return;
  const res = await call(`/v1/holds/${encodeURIComponent(hold.holdId)}`, { method: 'DELETE' });
  if (!res) return;
  if (res.status !== 204) {
    say(await problemText(res));
    return;
  }
  hold = undefined;
  mine = new Set();
  say('좌석을 놓았습니다');
  redraw();
});

extendBtn.addEventListener('click', async () => {
  if (!hold) return;
  const res = await call(`/v1/holds/${encodeURIComponent(hold.holdId)}/extension`, { method: 'POST' });
  if (!res) return;
  if (res.status !== 200) {
    say(await problemText(res));
    return;
  }
  hold = /** @type {Hold} */ (await res.json());
  say('홀드 시간을 한 번 늘렸습니다');
  redraw();
});

setInterval(() => {
  if (!hold) {
    timerEl.textContent = '';
    return;
  }
  const left = Date.parse(hold.expiresAt) - Date.now();
  if (left <= 0) {
    hold = undefined;
    mine = new Set();
    timerEl.textContent = '';
    say('홀드 시간이 끝나 좌석이 풀렸습니다');
    redraw();
    return;
  }
  const s = Math.ceil(left / 1000);
  timerEl.textContent = `남은 시간 ${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
}, 1000);

connect();
