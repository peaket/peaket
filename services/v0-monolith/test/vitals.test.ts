// v0 좌석맵의 랩 판정 계측(docs/features/seat-hold.md §14 동작 7, K5·NFR-012, BUILD_ORDER BSL-070 ②).
// 화면 파일 public/v0-seatmap/vitals.js가 내놓는 모음(web-vitals 값·LoAF 항목을 받아 window.__peaketVitals로 보이는 것)을 본다.
import { describe, expect, test } from 'vitest';
import { createVitalsSink } from '../public/v0-seatmap/vitals.js';

const inp = (value: number, target = 'canvas#map') => ({
  name: 'INP', value, rating: value <= 200 ? 'good' : 'poor', navigationType: 'navigate',
  attribution: {
    interactionTarget: target, interactionType: 'pointer', interactionTime: 5000, inputDelay: 5, processingDuration: value - 20, presentationDelay: 15,
    longAnimationFrameEntries: [{}], nextPaintTime: 5300, loadState: 'complete',
    longestScript: { entry: { invoker: 'HTMLCanvasElement.onpointerdown', sourceURL: 'http://x/v0/seatmap/assets/seatmap-page.js', duration: 90 }, subpart: 'processing-duration', intersectingDuration: 80 },
  },
});

describe('랩 판정 계측 모음', () => {
  test('K5 NFR012_INP·LCP·CLS는 바뀔 때마다 마지막 값과 원인 요약만 남긴다', () => {
    const s = createVitalsSink();
    s.metric(inp(90));
    s.metric(inp(240));
    s.metric({ name: 'LCP', value: 1200, rating: 'good', navigationType: 'navigate', attribution: { target: 'canvas#map', timeToFirstByte: 30, resourceLoadDelay: 0, resourceLoadDuration: 0, elementRenderDelay: 900 } });
    s.metric({ name: 'CLS', value: 0.01, rating: 'good', navigationType: 'navigate', attribution: { largestShiftTarget: 'p#status', largestShiftValue: 0.01 } });
    s.metric({ name: 'FID', value: 3, rating: 'good' });
    const v = s.snapshot();
    expect(v.inp).toEqual({
      value: 240, rating: 'poor', navigationType: 'navigate',
      attribution: {
        target: 'canvas#map', type: 'pointer', time: 5000, inputDelay: 5, processingDuration: 220, presentationDelay: 15,
        // INP에 겹친 가장 긴 스크립트(어느 함수가 막았는지)
        longestScript: { invoker: 'HTMLCanvasElement.onpointerdown', sourceURL: 'http://x/v0/seatmap/assets/seatmap-page.js', subpart: 'processing-duration', intersectingDuration: 80 },
      },
    });
    expect(v.lcp.value).toBe(1200);
    expect(v.lcp.attribution.elementRenderDelay).toBe(900);
    expect(v.cls.attribution).toEqual({ largestShiftTarget: 'p#status', largestShiftValue: 0.01 });
    expect(Object.keys(v).sort()).toEqual(['cls', 'inp', 'lcp', 'loaf', 'status']);
    // 원인 요소는 선택자 글만, 길이를 자른다(화면 내용을 담지 않는다)
    s.metric(inp(300, 'x'.repeat(500)));
    expect(s.snapshot().inp.attribution.target).toHaveLength(200);
  });

  test('K5 NFR012_50ms를 넘은 프레임(LoAF)의 수·합과 가장 긴 다섯 프레임의 원인 스크립트를 남긴다', () => {
    const s = createVitalsSink();
    const frame = (duration: number) => ({
      duration, blockingDuration: Math.max(0, duration - 50), startTime: 1000 + duration,
      scripts: [{ invoker: 'HTMLCanvasElement.onpointerdown', sourceURL: 'http://x/v0/seatmap/assets/seatmap-page.js', duration: duration - 10, extra: 'x' }],
    });
    s.loaf([frame(40), frame(60), frame(120), frame(80)]);
    s.loaf([frame(70), frame(200), frame(55), frame(51)]);
    const { loaf } = s.snapshot();
    expect(loaf.count).toBe(7);
    expect(loaf.totalMs).toBe(60 + 120 + 80 + 70 + 200 + 55 + 51);
    expect(loaf.worst.map((f: { duration: number }) => f.duration)).toEqual([200, 120, 80, 70, 60]);
    expect(loaf.worst[0].scripts).toEqual([{ invoker: 'HTMLCanvasElement.onpointerdown', sourceURL: 'http://x/v0/seatmap/assets/seatmap-page.js', duration: 190 }]);
  });

  test('K5 NFR012_프레임 안의 스크립트는 오래 걸린 순으로 다섯을 남기고, 정확히 50ms인 프레임은 세지 않는다', () => {
    const s = createVitalsSink();
    const scripts = [5, 9, 7, 30, 6, 8, 40].map((d, i) => ({ invoker: `f${i}`, sourceURL: 'http://x/a.js', duration: d }));
    s.loaf([{ duration: 120, blockingDuration: 70, startTime: 1, scripts }, { duration: 50, blockingDuration: 0, startTime: 2, scripts: [] }]);
    const { loaf } = s.snapshot();
    expect(loaf.count).toBe(1);
    expect(loaf.worst[0].scripts.map((x: { duration: number }) => x.duration)).toEqual([40, 30, 9, 8, 7]);
  });

  test('K5 NFR012_계측 상태를 함께 보여 값이 없음과 계측 고장을 나누고, 시나리오 시작에 비울 수 있다', () => {
    const s = createVitalsSink();
    expect(s.snapshot().status).toBe('loading');
    s.failed(new Error('web-vitals.js 404'));
    expect(s.snapshot()).toMatchObject({ status: 'error', error: 'web-vitals.js 404' });
    const t = createVitalsSink();
    t.ready();
    t.metric(inp(100));
    t.loaf([{ duration: 80, blockingDuration: 30, startTime: 1, scripts: [] }]);
    t.reset();
    expect(t.snapshot()).toEqual({ status: 'ready', inp: null, lcp: null, cls: null, loaf: { count: 0, totalMs: 0, worst: [] } });
  });

  test('K5 NFR012_보이는 값은 JSON으로 그대로 옮길 수 있는 사본이다(읽는 쪽이 고쳐도 모음이 바뀌지 않는다)', () => {
    const s = createVitalsSink();
    s.metric(inp(100));
    const a = s.snapshot();
    a.inp.value = 1;
    expect(s.snapshot().inp.value).toBe(100);
    expect(JSON.parse(JSON.stringify(s.snapshot()))).toEqual(s.snapshot());
  });
});
