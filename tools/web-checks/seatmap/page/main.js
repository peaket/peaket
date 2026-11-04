// 5만 석 좌석맵 PoC 메인 스레드(BUILD_ORDER BAS-190, K5, docs/frontend.md §5.2). 제품 코드가 아니다.
// Worker를 띄워 캔버스를 넘기고(transferControlToOffscreen), Worker가 보낸 상태 메시지를 접근성 목록 모형에 반영하는 시간을 잰다.
const abs = () => performance.timeOrigin + performance.now();
const result = { done: false, longTasks: [] };
window.__seatmapPoc = result;

// 긴 작업 감시는 Chromium에만 있다. 모르는 종류를 오류 없이 무시하는 엔진이 있어 먼저 확인한다(없으면 null = 잴 수 없음)
if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) result.longTasks.push(Math.round(e.duration));
  }).observe({ type: 'longtask', buffered: true });
} else {
  result.longTasks = null;
}

const started = abs();
const canvas = document.getElementById('seatmap');
// OffscreenCanvas가 없는 브라우저는 메인 스레드 그리기로 대신한다(docs/frontend.md FE-T15). PoC는 '미지원'으로 기록만 한다
if (!('transferControlToOffscreen' in canvas) || typeof OffscreenCanvas === 'undefined') {
  result.unsupported = 'OffscreenCanvas 없음';
  result.userAgent = navigator.userAgent;
  result.done = true;
  throw new Error('OffscreenCanvas 없음');
}
const W = canvas.clientWidth;
const H = canvas.clientHeight;
const offscreen = canvas.transferControlToOffscreen();
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'init', canvas: offscreen, width: W, height: H, dpr: window.devicePixelRatio, url: new URL('./gen/layout.json', import.meta.url).href }, [offscreen]);

/** 접근성 목록 모형(CMP-022): 지금 연 구역의 좌석 상태와 '가능' 좌석 수 */
const list = { section: -1, states: null, free: 0 };
const handle = [];
const latency = [];

worker.onmessage = (e) => {
  // 시간 재기를 먼저 시작한다: 받은 메시지는 data를 처음 읽을 때 풀린다(구조화 복제 풀기도 처리 시간에 넣는다)
  const t0 = performance.now();
  const m = e.data;
  if (m.type === 'ready') {
    result.ready = { ...m, startedAt: started, readyAt: abs() };
  } else if (m.type === 'sectionState') {
    latency.push(abs() - m.sentAt);
    list.section = m.section;
    list.states = m.states; // 소유권을 받은 배열을 그대로 쓴다(복사 없음)
    let free = 0;
    for (let i = 0; i < m.states.length; i++) if (m.states[i] === 0) free++;
    list.free = free;
    handle.push(performance.now() - t0);
  } else if (m.type === 'stateChanged') {
    latency.push(abs() - m.sentAt);
    if (list.states && m.section === list.section) {
      for (let i = 0; i < m.indices.length; i++) {
        const before = list.states[m.indices[i]];
        const after = m.states[i];
        if (before !== after) list.free += (after === 0) - (before === 0);
        list.states[m.indices[i]] = after;
      }
    }
    handle.push(performance.now() - t0);
  } else if (m.type === 'error') {
    result.error = m.message;
    result.done = true;
  } else if (m.type === 'done') {
    const q = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
    };
    result.messages = { count: handle.length, handleP95Ms: q(handle, 0.95), handleMaxMs: Math.max(...handle), latencyP95Ms: q(latency, 0.95) };
    result.userAgent = navigator.userAgent;
    result.done = true;
  }
};
worker.onerror = (e) => {
  result.error = String(e.message ?? e);
  result.done = true;
};
