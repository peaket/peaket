// 좌석맵 랩 web-vitals 수집기(F-08-1, docs/frontend.md §5.8 '판정은 둘로 나눈다'·'좌석맵 INP 시나리오').
// 브라우저 표준 PerformanceObserver만 쓴다(새 패키지 의존성 없음). 페이지 스크립트보다 먼저 넣고, 시나리오 시작에
// window.__peaketVitalsReset()으로 비운 뒤 window.__peaketVitals로 읽는다. v0 좌석맵의 계측(services/v0-monolith/public/v0-seatmap/vitals.js)과
// 같은 이름·모양을 쓴다: status(loading·ready·error), inp·lcp·cls, loaf(개수·합·가장 긴 다섯), longTasks.
// INP는 web-vitals와 같은 정의로 사건 상호작용(interactionId)마다 최대 duration을 모아 p98(가까운 순위)을 쓴다.
// CLS는 세션 창(첫 이동에서 5초 안, 1초 넘게 쉬면 새 창) 가운데 가장 큰 합이다. hadRecentInput 이동은 뺀다.
export const VITALS_COLLECTOR = () => {
  const w = window;
  const perf = performance;
  const state = { status: 'loading', lcpMs: null, clS: 0, loaf: [], longTasks: [], interactions: new Map(), resetAt: 0, error: null };
  let sessionFirst = 0;
  let sessionLast = 0;
  let sessionValue = 0;
  let clS = 0;

  const supported = (t) => Array.isArray(PerformanceObserver.supportedEntryTypes) && PerformanceObserver.supportedEntryTypes.includes(t);
  const observe = (type, fn, extra) => {
    try {
      new PerformanceObserver((list) => fn(list.getEntries())).observe({ type, buffered: true, ...extra });
      return true;
    } catch (e) {
      return false;
    }
  };

  if (typeof PerformanceObserver !== 'function') {
    state.status = 'error';
    state.error = 'PerformanceObserver 없음';
  } else {
    // LCP: 마지막으로 보고된 가장 큰 요소의 표시 시각. 화면 적재 지표라 reset이 비우지 않는다(회차마다 새 페이지다)
    observe('largest-contentful-paint', (es) => {
      for (const e of es) state.lcpMs = e.startTime;
    });
    // CLS: 세션 창 최대 합. 5초 창·1초 간격
    observe('layout-shift', (es) => {
      for (const e of es) {
        if (e.startTime < state.resetAt || e.hadRecentInput) continue;
        if (sessionValue === 0 || e.startTime - sessionLast > 1000 || e.startTime - sessionFirst > 5000) {
          sessionFirst = e.startTime;
          sessionValue = 0;
        }
        sessionValue += e.value;
        sessionLast = e.startTime;
        if (sessionValue > clS) clS = sessionValue;
      }
    });
    // INP: 사건 상호작용마다 최대 duration. Event Timing은 16ms 이상만 보고한다(durationThreshold)
    if (supported('event')) {
      observe(
        'event',
        (es) => {
          for (const e of es) {
            if (e.startTime < state.resetAt || !e.interactionId) continue;
            const prev = state.interactions.get(e.interactionId) ?? 0;
            if (e.duration > prev) state.interactions.set(e.interactionId, e.duration);
          }
        },
        { durationThreshold: 16 },
      );
    }
    // LoAF(Chromium 123+): 50ms 넘은 프레임과 원인 스크립트
    if (supported('long-animation-frame')) {
      observe('long-animation-frame', (es) => {
        for (const e of es) {
          if (e.startTime < state.resetAt) continue;
          state.loaf.push({
            startTime: e.startTime,
            duration: e.duration,
            blockingDuration: e.blockingDuration ?? 0,
            scripts: (e.scripts ?? []).slice(0, 5).map((s) => ({ invoker: s.invoker, sourceURL: s.sourceURL, duration: s.duration, forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration ?? 0 })),
          });
        }
      });
    }
    // 긴 작업(50ms 이상). LoAF가 없는 브라우저에서도 남는다
    observe('longtask', (es) => {
      for (const e of es) if (e.startTime >= state.resetAt) state.longTasks.push(e.duration);
    });
    state.status = 'ready';
  }

  const nearRank = (xs, p) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  };
  const snapshot = () => {
    const durations = [...state.interactions.values()];
    const inp = durations.length ? nearRank(durations, 0.98) : null;
    const loaf = [...state.loaf];
    const totalLoaf = loaf.reduce((n, x) => n + x.duration, 0);
    const top = [...loaf].sort((a, b) => b.duration - a.duration).slice(0, 5);
    return {
      status: state.status,
      error: state.error,
      inpMs: inp,
      lcpMs: state.lcpMs,
      cls: Math.round(clS * 100000) / 100000,
      loaf: { count: loaf.length, totalMs: Math.round(totalLoaf * 10) / 10, top },
      longTasks: { count: state.longTasks.length, totalMs: Math.round(state.longTasks.reduce((a, b) => a + b, 0) * 10) / 10 },
      interactions: durations.length,
    };
  };

  Object.defineProperty(w, '__peaketVitals', { get: snapshot, configurable: true });
  w.__peaketVitalsReset = () => {
    state.resetAt = perf.now();
    state.interactions.clear();
    state.loaf.length = 0;
    state.longTasks.length = 0;
    sessionFirst = 0;
    sessionLast = 0;
    sessionValue = 0;
    clS = 0;
  };
};

/** 페이지 스크립트보다 먼저 넣는 원문(`page.addInitScript({content})`) */
export const VITALS_COLLECTOR_SOURCE = `(${VITALS_COLLECTOR.toString()})();`;
