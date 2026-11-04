// 5만 석 좌석맵 PoC Worker(BUILD_ORDER BAS-190, K5, docs/frontend.md §3.5·§5.2). 제품 코드가 아니다.
// 열 단위 좌석맵 파일을 받아 형식 배열(Float32Array·Uint8Array)로 풀고 구역별 격자 색인을 만든 뒤 OffscreenCanvas에 그린다.
// 잰 값은 절대 시각(timeOrigin + now)으로 메인에 보낸다.
// 풀기 뒤에는 그리기·홀드 요청에 쓰는 것(형식 배열, 좌석 ID 열, 구역 이름·도형·글자 자리, 무대, 캔버스 크기)만 쥐고 JSON 나머지는 버린다(힙).
const abs = () => performance.timeOrigin + performance.now();
// Chromium 캔버스는 그리기 명령을 모아 두었다가 나중에 그린다. 잰 구간 끝에서 한 화소를 읽어 그리기를 끝내게 한다(읽기 비용이 더해져 보수적이다)
const flush = (c) => c.getImageData(0, 0, 1, 1);
const nextFrame = () => new Promise((ok) => (self.requestAnimationFrame ? self.requestAnimationFrame(() => ok()) : setTimeout(ok, 0)));

/** 상태 값(§3.5): 0 가능, 1 다른 분 선택, 2 판매, 3 선택 불가 */
const STATE_COLOR = ['#3f8f5a', '#c9ccd2', '#7d828b', '#e3e5e8'];
const TIER_COLOR = ['#4c3fb1', '#2f7bd6', '#2c9a8c', '#c08a2b'];
const CELL = 200; // 격자 칸 2m [가정]

let ctx, W, H, DPR, L;

/** 열 단위 JSON → 형식 배열 */
function decode(json) {
  const N = json.seatCount;
  const S = json.sections.length;
  const x = new Float32Array(N);
  const y = new Float32Array(N);
  const attr = new Uint8Array(N); // 아래 4비트 등급 색인, 위 4비트 플래그
  const state = new Uint8Array(N);
  const sectionStart = new Uint32Array(S);
  const sectionEnd = new Uint32Array(S);
  const bounds = new Float32Array(S * 4);
  const seatIds = [];
  for (let s = 0; s < S; s++) {
    const sec = json.sections[s];
    const c = sec.seats;
    const start = sec.seatIndexRange.start;
    sectionStart[s] = start;
    sectionEnd[s] = sec.seatIndexRange.end;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < c.x.length; i++) {
      const k = start + i;
      x[k] = c.x[i];
      y[k] = c.y[i];
      attr[k] = (c.tier[i] & 15) | ((c.flags[i] & 15) << 4);
      if (c.x[i] < minX) minX = c.x[i];
      if (c.y[i] < minY) minY = c.y[i];
      if (c.x[i] > maxX) maxX = c.x[i];
      if (c.y[i] > maxY) maxY = c.y[i];
    }
    bounds.set([minX, minY, maxX, maxY], s * 4);
    seatIds.push(c.seatId); // 좌석 ID 문자열은 홀드 요청 때만 쓴다(복사하지 않는다)
  }
  // 스냅샷 대신: 정해진 규칙으로 30%를 다른 분 선택·판매로 둔다
  for (let k = 0; k < N; k++) {
    const h = Math.imul(k ^ 0x5bd1e995, 2654435761) >>> 0;
    const r = h % 100;
    state[k] = r < 15 ? 2 : r < 30 ? 1 : 0;
  }
  // 그리기에 쓰는 구역 정보만 옮긴다. 좌석 열(row·number·x·y·tier·flags)과 원문 JSON은 쥐지 않는다(좌석 ID 열만 남긴다)
  const meta = {
    canvas: json.canvas,
    stage: json.stage,
    sections: json.sections.map((sec) => ({ name: sec.name, shape: sec.shape, label: sec.label })),
  };
  return { N, S, x, y, attr, state, sectionStart, sectionEnd, bounds, seatIds, meta };
}

/**
 * 받기·JSON 풀기·형식 배열. 원문 글과 JSON은 이 함수의 지역 값이라 돌아가면 버려진다(keep이 'json'이면 예전처럼 L.json에 쥔다)
 * @returns {Promise<{ L: object, jsonChars: number, encoding: string | null, fromCache: boolean | null }>}
 */
async function load(url, t, keep) {
  const res = await fetch(url);
  const text = await res.text();
  t.fetched = abs();
  const json = JSON.parse(text);
  t.parsed = abs();
  const out = decode(json);
  t.decoded = abs();
  if (keep === 'json') out.json = json;
  // 전송 크기 0이면 HTTP 캐시에서 읽었다(Resource Timing. 모르는 엔진은 null)
  const entry = performance.getEntriesByName(url).pop();
  const fromCache = entry && 'transferSize' in entry ? entry.transferSize === 0 : null;
  return { L: out, jsonChars: text.length, encoding: res.headers.get('content-encoding'), fromCache };
}

/** 구역별 격자 색인(CSR): 칸 → 좌석 색인 목록 */
function buildGrid() {
  L.grid = [];
  for (let s = 0; s < L.S; s++) {
    const [minX, minY, maxX, maxY] = L.bounds.subarray(s * 4, s * 4 + 4);
    const cols = Math.max(1, Math.ceil((maxX - minX + 1) / CELL));
    const rows = Math.max(1, Math.ceil((maxY - minY + 1) / CELL));
    const count = new Uint32Array(cols * rows + 1);
    const a = L.sectionStart[s];
    const b = L.sectionEnd[s];
    const cellOf = (k) => Math.min(rows - 1, Math.floor((L.y[k] - minY) / CELL)) * cols + Math.min(cols - 1, Math.floor((L.x[k] - minX) / CELL));
    for (let k = a; k <= b; k++) count[cellOf(k) + 1]++;
    for (let c = 1; c < count.length; c++) count[c] += count[c - 1];
    const items = new Uint32Array(b - a + 1);
    const fill = count.slice(0, -1);
    for (let k = a; k <= b; k++) items[fill[cellOf(k)]++] = k;
    L.grid.push({ minX, minY, cols, rows, start: count, items });
  }
}

/** 화면 점(CSS px) → 좌석 색인(없으면 -1) */
function hit(cam, px, py) {
  const wx = (px - cam.tx) / cam.scale;
  const wy = (py - cam.ty) / cam.scale;
  const R2 = 30 * 30; // 좌석 중심에서 30cm 안 [가정]
  for (let s = 0; s < L.S; s++) {
    const [minX, minY, maxX, maxY] = L.bounds.subarray(s * 4, s * 4 + 4);
    if (wx < minX - CELL || wx > maxX + CELL || wy < minY - CELL || wy > maxY + CELL) continue;
    const g = L.grid[s];
    const cx = Math.floor((wx - g.minX) / CELL);
    const cy = Math.floor((wy - g.minY) / CELL);
    let best = -1;
    let bestD = R2;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx;
        const Y = cy + dy;
        if (X < 0 || Y < 0 || X >= g.cols || Y >= g.rows) continue;
        const c = Y * g.cols + X;
        for (let i = g.start[c]; i < g.start[c + 1]; i++) {
          const k = g.items[i];
          const d = (L.x[k] - wx) ** 2 + (L.y[k] - wy) ** 2;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function clear() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W * DPR, H * DPR);
}

/** 전체 배치도: 무대·구역 도형과 구역 상태(남은 비율)만 그린다(§5.2 단계 5) */
function drawOverview(cam) {
  clear();
  ctx.setTransform(DPR * cam.scale, 0, 0, DPR * cam.scale, DPR * cam.tx, DPR * cam.ty);
  ctx.fillStyle = '#1b1d22';
  for (const st of L.meta.stage) {
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let s = 0; s < L.S; s++) {
    const sec = L.meta.sections[s];
    let free = 0;
    for (let k = L.sectionStart[s]; k <= L.sectionEnd[s]; k++) if (L.state[k] === 0) free++;
    const ratio = free / (L.sectionEnd[s] - L.sectionStart[s] + 1);
    ctx.fillStyle = ratio > 0.5 ? '#cfe9d8' : ratio > 0.1 ? '#f4e2b8' : '#e3e5e8';
    ctx.strokeStyle = '#5b606a';
    ctx.lineWidth = 2 / (DPR * cam.scale);
    ctx.beginPath();
    sec.shape.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#1b1d22';
  ctx.font = '600 12px system-ui, sans-serif';
  for (const sec of L.meta.sections) ctx.fillText(sec.name, cam.tx + sec.label.x * cam.scale - 14, cam.ty + sec.label.y * cam.scale + 4);
}

/** 좌석 하나: 상태 색 + 무늬(판매 X, 다른 분 선택 빗금 한 줄, 내 좌석은 테두리) — 색만으로 가르지 않는다(d2 §1) */
function drawSeat(k, cam, size) {
  const sx = cam.tx + L.x[k] * cam.scale;
  const sy = cam.ty + L.y[k] * cam.scale;
  const st = L.state[k];
  ctx.fillStyle = st === 0 ? TIER_COLOR[L.attr[k] & 15] : STATE_COLOR[st];
  ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
  if (st === 2 && size >= 6) {
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(sx - size / 3, sy - size / 3);
    ctx.lineTo(sx + size / 3, sy + size / 3);
    ctx.moveTo(sx + size / 3, sy - size / 3);
    ctx.lineTo(sx - size / 3, sy + size / 3);
    ctx.stroke();
  } else if (st === 1 && size >= 6) {
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(sx - size / 2, sy + size / 2);
    ctx.lineTo(sx + size / 2, sy - size / 2);
    ctx.stroke();
  }
}

/** 화면에 보이는 좌석만 직접 그린다. 그린 좌석 수를 돌려준다 */
function drawSeats(cam) {
  clear();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const size = Math.max(1, 50 * cam.scale * 0.8);
  ctx.lineWidth = 1;
  const x0 = -cam.tx / cam.scale;
  const y0 = -cam.ty / cam.scale;
  const x1 = x0 + W / cam.scale;
  const y1 = y0 + H / cam.scale;
  let drawn = 0;
  for (let s = 0; s < L.S; s++) {
    const [minX, minY, maxX, maxY] = L.bounds.subarray(s * 4, s * 4 + 4);
    if (maxX < x0 || minX > x1 || maxY < y0 || minY > y1) continue;
    for (let k = L.sectionStart[s]; k <= L.sectionEnd[s]; k++) {
      if (L.x[k] < x0 - 50 || L.x[k] > x1 + 50 || L.y[k] < y0 - 50 || L.y[k] > y1 + 50) continue;
      drawSeat(k, cam, size);
      drawn++;
    }
  }
  return drawn;
}

/** 구역 하나를 그 배율로 미리 그린 비트맵(§5.2 '구역별로 미리 그린 비트맵')과 그 메모리(바이트) */
function prerenderSection(s, scale) {
  const [minX, minY, maxX, maxY] = L.bounds.subarray(s * 4, s * 4 + 4);
  const w = Math.ceil((maxX - minX + 100) * scale * DPR);
  const h = Math.ceil((maxY - minY + 100) * scale * DPR);
  const oc = new OffscreenCanvas(w, h);
  const c2 = oc.getContext('2d');
  const saved = ctx;
  ctx = c2;
  const cam = { scale, tx: (-minX + 50) * scale, ty: (-minY + 50) * scale };
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const size = Math.max(1, 50 * scale * 0.8);
  for (let k = L.sectionStart[s]; k <= L.sectionEnd[s]; k++) drawSeat(k, cam, size);
  ctx = saved;
  return { bitmap: oc.transferToImageBitmap(), bytes: w * h * 4, w, h };
}

const cameraFit = (bx, by, bw, bh) => {
  const scale = Math.min(W / bw, H / bh);
  return { scale, tx: (W - bw * scale) / 2 - bx * scale, ty: (H - bh * scale) / 2 - by * scale };
};

self.onmessage = (e) => {
  if (e.data?.type !== 'init') return;
  run(e.data).catch((err) => self.postMessage({ type: 'error', message: String(err?.stack ?? err) }));
};

async function run(m) {
  const t = { workerStart: abs() };
  W = m.width;
  H = m.height;
  DPR = m.dpr;
  const canvas = m.canvas;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx = canvas.getContext('2d', { alpha: false });
  const loaded = await load(m.url, t, m.keep);
  L = loaded.L;
  buildGrid();
  t.indexed = abs();
  const cv = L.meta.canvas;
  const overviewCam = cameraFit(cv.minX, cv.minY, cv.width, cv.height);
  drawOverview(overviewCam);
  flush(ctx);
  t.overviewDrawn = abs();
  await nextFrame();
  t.overviewFrame = abs();

  // 확대 ①: 구역 하나가 화면 폭을 채우는 배율(좌석은 작은 점)
  const b0 = L.bounds.subarray(0, 4);
  const midCam = cameraFit(b0[0] - 100, b0[1] - 100, b0[2] - b0[0] + 200, b0[3] - b0[1] + 200);
  let a = abs();
  const midDrawn = drawSeats(midCam);
  flush(ctx);
  const midDirectMs = abs() - a;
  a = abs();
  const pre = prerenderSection(0, midCam.scale);
  const prerenderMs = abs() - a;
  a = abs();
  clear();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(pre.bitmap, Math.round((midCam.tx + (b0[0] - 50) * midCam.scale) * DPR), Math.round((midCam.ty + (b0[1] - 50) * midCam.scale) * DPR));
  flush(ctx);
  const blitMs = abs() - a;

  // 확대 ②: 좌석을 고를 수 있는 배율(좌석 간격 50cm가 24 CSS px, WCAG 2.5.8)
  const scale = 24 / 50;
  const closeCam = { scale, tx: W / 2 - (b0[0] + 2000) * scale, ty: H / 2 - (b0[1] + 1500) * scale };
  a = abs();
  const closeDrawn = drawSeats(closeCam);
  flush(ctx);
  const closeMs = abs() - a;

  // 델타 덧칠: 보이는 구역에서 100석의 상태를 바꾸고 바뀐 좌석만 다시 그린다
  const changed = [];
  for (let i = 0; i < 100; i++) changed.push(L.sectionStart[0] + ((i * 7919) % (L.sectionEnd[0] - L.sectionStart[0])));
  a = abs();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (const k of changed) {
    L.state[k] = (L.state[k] + 1) % 3;
    drawSeat(k, closeCam, 50 * scale * 0.8);
  }
  flush(ctx);
  const deltaMs = abs() - a;

  // 누른 좌석 찾기: 화면 안 점 1,000개
  a = abs();
  let hits = 0;
  for (let i = 0; i < 1000; i++) if (hit(closeCam, ((i * 37) % W) + 0.5, ((i * 53) % H) + 0.5) >= 0) hits++;
  const hitAvgUs = ((abs() - a) / 1000) * 1000;

  self.postMessage({
    type: 'ready',
    t,
    seatCount: L.N,
    sections: L.S,
    jsonChars: loaded.jsonChars,
    encoding: loaded.encoding,
    fromCache: loaded.fromCache,
    mid: { drawn: midDrawn, directMs: midDirectMs, prerenderMs, blitMs, bitmapBytes: pre.bytes, bitmapPx: [pre.w, pre.h] },
    close: { drawn: closeDrawn, ms: closeMs },
    deltaMs,
    hit: { avgUs: hitAvgUs, hits },
  });

  // 메시지 비용: 구역 상태 전체(sectionState, 구역 하나 5,000바이트) 10번과 바뀐 좌석(stateChanged, 20석) 200번을 소유권을 넘겨 보낸다
  for (let i = 0; i < 10; i++) {
    const s = i % L.S;
    const states = L.state.slice(L.sectionStart[s], L.sectionEnd[s] + 1);
    self.postMessage({ type: 'sectionState', section: s, sentAt: abs(), states }, [states.buffer]);
  }
  for (let i = 0; i < 200; i++) {
    const s = i % L.S;
    const idx = new Uint16Array(20);
    const st = new Uint8Array(20);
    for (let j = 0; j < 20; j++) {
      idx[j] = (i * 131 + j * 17) % (L.sectionEnd[s] - L.sectionStart[s] + 1);
      st[j] = (i + j) % 3;
    }
    self.postMessage({ type: 'stateChanged', section: s, sentAt: abs(), indices: idx, states: st }, [idx.buffer, st.buffer]);
    if (i % 20 === 19) await new Promise((ok) => setTimeout(ok, 0));
  }
  self.postMessage({ type: 'done' });
}
