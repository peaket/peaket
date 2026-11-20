// 5만 석 좌석 화면 시험 페이지(S-T21·S-T31 ⑥, BAT-182). 제품 화면(SeatsLive)과 같은 부품을 같은 순서로 쓴다.
// 첫 그림(ready) 뒤 stream을 한 번 보내고, 탭 보임을 알리며, Worker의 connection·sections·metrics를 모아 검사가 읽게 한다.
// 화면 잃기(dispose)도 검사가 부를 수 있게 열어 둔다.
import { createSeatMap, type FromWorker } from '../../../../packages/seatmap/src/index';

const q = new URLSearchParams(location.search);
const eventId = q.get('event') ?? 'evt-50k';
const canvas = document.getElementById('map') as HTMLCanvasElement;
const messages: FromWorker[] = [];
/** 델타 종단 지연(ms, Worker의 metrics). p99를 잰다 */
const metrics: number[] = [];
/** 화면을 그리는 동안의 Long Task 길이(ms). 확대·축소 중 0이어야 한다 */
const longTasks: number[] = [];
if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    // Long Task를 못 보는 브라우저면 빈 배열로 남는다(Chromium은 본다)
  }
}
const started = performance.timeOrigin + performance.now();
let streamSent = false;

const map = createSeatMap({
  canvas,
  layoutUrl: `/v1/events/${encodeURIComponent(eventId)}/seatmap-layouts/1.json`,
  snapshotUrl: `/v1/events/${encodeURIComponent(eventId)}/seatmap-snapshot`,
  admission: { token: 'harness.admission.token' },
  theme: 'light',
  createWorker: () => new Worker(new URL('../../../../packages/seatmap/src/worker.ts', import.meta.url), { type: 'module' }),
  onMessage: (m) => {
    messages.push(m);
    if (m.type === 'metrics' && m.deltaE2eMs !== undefined) metrics.push(m.deltaE2eMs);
    if (m.type === 'ready' && !streamSent) {
      streamSent = true;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // 제품 화면과 같은 순서: 지금 탭 보임 → stream 한 번(§5.2)
      map.send({ type: 'visibility', visible: document.visibilityState !== 'hidden' });
      map.send({ type: 'stream', url: `${proto}//${location.host}/v1/events/${encodeURIComponent(eventId)}/seats/stream`, expiresAtMs: Date.now() + 3_600_000 });
    }
  },
});

// 검사가 읽고 보낸다
Object.assign(window, {
  __seats: {
    mode: map.mode,
    messages,
    metrics,
    longTasks,
    started,
    send: map.send,
    dispose: map.dispose,
  },
});
