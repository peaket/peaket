// @ts-check
// v0 좌석맵의 랩 판정 계측(docs/features/seat-hold.md §14 동작 7, K5·NFR-012, docs/frontend.md §5.8 '판정은 둘로 나눈다').
// 같은 출처의 web-vitals 6.2.3 속성 정보 빌드(web-vitals.js)로 INP·LCP·CLS를, long-animation-frame 관찰로 50ms 넘은 프레임을 모아
// window.__peaketVitals에 둔다. 랩 판정 스크립트(Playwright)가 읽는다. v0에는 텔레메트리 입구가 없어 밖으로 보내지 않는다.

const LOAF_MS = 50;
const WORST = 5;
const TARGET_MAX = 200;

/** @param {unknown} v */
const selector = (v) => (typeof v === 'string' ? v.slice(0, TARGET_MAX) : undefined);

/**
 * 원인 요약: 선택자 글과 시간 나눔만 남긴다(화면 내용·요소는 담지 않는다)
 * @param {string} name
 * @param {any} a
 */
function attributionOf(name, a = {}) {
  if (name === 'inp') {
    const ls = a.longestScript;
    return {
      target: selector(a.interactionTarget), type: a.interactionType, time: a.interactionTime,
      inputDelay: a.inputDelay, processingDuration: a.processingDuration, presentationDelay: a.presentationDelay,
      // INP에 겹친 가장 긴 스크립트(LoAF, 어느 함수가 막았는지)
      longestScript: ls ? { invoker: ls.entry?.invoker, sourceURL: ls.entry?.sourceURL, subpart: ls.subpart, intersectingDuration: ls.intersectingDuration } : undefined,
    };
  }
  if (name === 'lcp') {
    return { target: selector(a.target), timeToFirstByte: a.timeToFirstByte, resourceLoadDelay: a.resourceLoadDelay, resourceLoadDuration: a.resourceLoadDuration, elementRenderDelay: a.elementRenderDelay };
  }
  return { largestShiftTarget: selector(a.largestShiftTarget), largestShiftValue: a.largestShiftValue };
}

/** web-vitals 값과 LoAF 항목을 받아 두는 모음 */
export function createVitalsSink() {
  /** @type {{ status: string, error?: string, inp: any, lcp: any, cls: any, loaf: { count: number, totalMs: number, worst: any[] } }} */
  const state = { status: 'loading', inp: null, lcp: null, cls: null, loaf: { count: 0, totalMs: 0, worst: [] } };
  return {
    /** web-vitals를 불러와 이었다 */
    ready() {
      state.status = 'ready';
    },
    /** @param {unknown} e 불러오기 실패(읽는 쪽이 '값이 없음'과 '계측 고장'을 나누게) */
    failed(e) {
      state.status = 'error';
      state.error = String(/** @type {any} */ (e)?.message ?? e).slice(0, TARGET_MAX);
    },
    /** 시나리오 시작에 모은 값을 비운다(상태는 그대로) */
    reset() {
      state.inp = state.lcp = state.cls = null;
      state.loaf = { count: 0, totalMs: 0, worst: [] };
    },
    /** @param {any} m web-vitals 값(속성 정보 빌드) */
    metric(m) {
      const name = String(m?.name ?? '').toLowerCase();
      if (name !== 'inp' && name !== 'lcp' && name !== 'cls') return;
      state[name] = { value: m.value, rating: m.rating, navigationType: m.navigationType, attribution: attributionOf(name, m.attribution) };
    },
    /** @param {any[]} entries long-animation-frame 항목 */
    loaf(entries) {
      for (const e of entries) {
        if (!(e.duration > LOAF_MS)) continue;
        state.loaf.count += 1;
        state.loaf.totalMs += e.duration;
        state.loaf.worst.push({
          duration: e.duration, blockingDuration: e.blockingDuration, startTime: e.startTime,
          // LoAF의 scripts는 실행 순서다. 오래 걸린 순으로 다섯을 남긴다
          scripts: [...(e.scripts ?? [])].sort((/** @type {any} */ x, /** @type {any} */ y) => y.duration - x.duration).slice(0, WORST)
            .map((/** @type {any} */ s) => ({ invoker: s.invoker, sourceURL: s.sourceURL, duration: s.duration })),
        });
      }
      state.loaf.worst.sort((a, b) => b.duration - a.duration);
      state.loaf.worst.length = Math.min(state.loaf.worst.length, WORST);
    },
    /** 읽는 쪽이 고쳐도 모음이 바뀌지 않는 사본 */
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

// 이 파일은 단위 시험(Node)에서도 읽혀 형 검사가 화면 전용 이름을 모를 수 있다. 화면 전역은 globalThis로 읽는다
/** @type {any} */
const g = globalThis;

/** 화면에서: 모음을 window.__peaketVitals로 보이고(시나리오 시작에 window.__peaketVitalsReset()으로 비운다) web-vitals와 LoAF 관찰을 잇는다 */
async function install() {
  const sink = createVitalsSink();
  Object.defineProperty(g.window, '__peaketVitals', { get: () => sink.snapshot(), configurable: true });
  g.window.__peaketVitalsReset = () => sink.reset();
  // LoAF 관찰은 web-vitals 불러오기와 상관없이 먼저 붙인다
  if (g.PerformanceObserver?.supportedEntryTypes?.includes('long-animation-frame')) {
    new g.PerformanceObserver((/** @type {any} */ list) => sink.loaf(list.getEntries())).observe({ type: 'long-animation-frame', buffered: true });
  }
  try {
    // 같은 출처의 고정 판 파일. 주소를 글로 만들어 불러 형 검사가 모듈을 찾지 않게 한다
    /** @type {any} */
    const wv = await import(new URL('./web-vitals.js', import.meta.url).href);
    const opts = { reportAllChanges: true };
    wv.onINP(sink.metric, opts);
    wv.onLCP(sink.metric, opts);
    wv.onCLS(sink.metric, opts);
    sink.ready();
  } catch (e) {
    sink.failed(e);
  }
}

if (g.window && g.document) void install();
