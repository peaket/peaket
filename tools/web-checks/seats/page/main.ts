// 5만 석 좌석 화면 시험 페이지(S-T21·S-T31 ⑥, BAT-182; F-08-1 랩). 제품 화면(SeatsLive)과 같은 부품을 같은 순서로 쓴다.
// 첫 그림(ready) 뒤 stream을 한 번 보내고, 탭 보임을 알리며, Worker의 connection·sections·metrics를 모아 검사가 읽게 한다.
// ?main=1이면 Worker를 쓰지 않고 같은 엔진의 메인 스레드 대체 길로 그린다(F-08-1 Canvas/Worker 랩, docs/frontend.md FE-T15).
// F-08-1 랩은 포인터로 좌석을 누르고(INP), 회차 사이에 reset()으로 긴 작업·메시지 기록을 비운다.
import { createSeatMap, type FromWorker } from '../../../../packages/seatmap/src/index';

const q = new URLSearchParams(location.search);
const eventId = q.get('event') ?? 'evt-50k';
const forceMain = q.get('main') === '1';
const canvas = document.getElementById('map') as HTMLCanvasElement;
// 랩은 중급 모바일 폭(412px)에서 잰다. 시험 페이지의 기본 캔버스(1280×800)를 회차 조건에 맞춰 줄인다
const cw = Number(q.get('w') ?? NaN);
const ch = Number(q.get('h') ?? NaN);
if (Number.isFinite(cw) && cw > 0) canvas.style.width = `${cw}px`;
if (Number.isFinite(ch) && ch > 0) canvas.style.height = `${ch}px`;
const messages: FromWorker[] = [];
/** 델타 종단 지연(ms, Worker의 metrics). p99를 잰다 */
const metrics: number[] = [];
/** onMessage 처리 시간(ms). 브라우저가 메시지를 넘긴 뒤 화면 쪽이 처리한 시간(풀기 포함) */
const handled: number[] = [];
/** 화면을 그리는 동안의 Long Task 길이(ms). 확대·축소 중 0이어야 한다. reset()이 비운다 */
const longTasks: number[] = [];
let resetAt = 0;
if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.startTime >= resetAt) longTasks.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    // Long Task를 못 보는 브라우저면 빈 배열로 남는다(Chromium은 본다)
  }
}
const navStart = performance.timeOrigin;
const started = performance.timeOrigin + performance.now();
let streamSent = false;

const map = createSeatMap({
  canvas,
  layoutUrl: `/v1/events/${encodeURIComponent(eventId)}/seatmap-layouts/1.json`,
  snapshotUrl: `/v1/events/${encodeURIComponent(eventId)}/seatmap-snapshot`,
  admission: { token: 'harness.admission.token' },
  theme: 'light',
  createWorker: () => new Worker(new URL('../../../../packages/seatmap/src/worker.ts', import.meta.url), { type: 'module' }),
  // ?main=1: OffscreenCanvas가 있어도 메인 스레드 대체 길로 그린다(Canvas 랩)
  ...(forceMain ? { env: {} } : {}),
  onMessage: (m) => {
    const t0 = performance.now();
    messages.push(m);
    if (m.type === 'metrics' && m.deltaE2eMs !== undefined) metrics.push(m.deltaE2eMs);
    // 시연 페이지처럼 누른 좌석을 고른다(데모 packages/seatmap/demo/main.ts와 같은 순서)
    if (m.type === 'hit' && m.seatIndex >= 0) map.send({ type: 'select', seatIndex: m.seatIndex });
    handled.push(performance.now() - t0);
    if (m.type === 'ready' && !streamSent) {
      streamSent = true;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // 제품 화면과 같은 순서: 지금 탭 보임 → stream 한 번(§5.2)
      map.send({ type: 'visibility', visible: document.visibilityState !== 'hidden' });
      map.send({ type: 'stream', url: `${proto}//${location.host}/v1/events/${encodeURIComponent(eventId)}/seats/stream`, expiresAtMs: Date.now() + 3_600_000 });
    }
  },
});

// 화면을 누르면 그 자리를 알린다(좌석 단계에서 hit → select). 제품 화면의 포인터 처리를 흉내 낸다
canvas.addEventListener('pointerup', (e) => {
  const r = canvas.getBoundingClientRect();
  map.send({ type: 'pointer', kind: 'up', x: e.clientX - r.left, y: e.clientY - r.top });
});
// 휠 확대·축소(제품 화면의 확대 동작). 랩에서 실제 입력 사건으로 확대한다
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    map.send({ type: 'zoomBy', factor: e.deltaY < 0 ? 1.2 : 1 / 1.2, x: e.clientX - r.left, y: e.clientY - r.top });
  },
  { passive: false },
);

/** 랩 회차 사이에 긴 작업·메시지·계측을 비운다(수집기의 __peaketVitalsReset과 함께 부른다) */
const reset = () => {
  resetAt = performance.now();
  longTasks.length = 0;
  handled.length = 0;
  messages.length = 0;
  metrics.length = 0;
};

// 검사가 읽고 보낸다
Object.assign(window, {
  __seats: {
    mode: map.mode,
    messages,
    metrics,
    handled,
    longTasks,
    navStart,
    started,
    send: map.send,
    dispose: map.dispose,
    reset,
  },
});
