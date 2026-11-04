// 구간 1 끝 정리(docs/lanes/lane2.md '구간 끝 정리 목록', BAS-210 지적) 재현 시험. 고치기 전에 실패하는 것을 확인했다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRumBatcher, routeTemplate, sendBatch, startRumSchedule } from '../src/lite';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('지표 보내기 일정·길', () => {
  it('FE-T22 화면이 보이는 동안 60초마다, 화면을 숨길 때 바로 보낸다', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const b = createRumBatcher({ app: 'web', routes: ['/'], send: async (body) => void sent.push(body) });
    const listeners: Record<string, () => void> = {};
    const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (t: string, f: () => void) => void (listeners[t] = f), removeEventListener: vi.fn() };
    const stop = startRumSchedule(b, doc);
    b.add({ route: '/' });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    b.add({ route: '/' });
    doc.visibilityState = 'hidden';
    listeners.visibilitychange!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    stop();
    expect(doc.removeEventListener).toHaveBeenCalled();
  });

  it('FE-T22 숨길 때는 keepalive 한도(진행 중 본문 합 64KiB) 안의 묶음만 바로 내보내고 나머지는 남겨, 다시 보일 때 주기 보내기가 모두 보낸다', async () => {
    const inFlight: number[] = [];
    let total = 0;
    const sent: string[] = [];
    const send = (body: string) => {
      const n = new TextEncoder().encode(body).length;
      total += n;
      inFlight.push(total);
      sent.push(body);
      return Promise.resolve();
    };
    const b = createRumBatcher({ app: 'web', routes: ['/'], send });
    for (let i = 0; i < 40; i++) b.add({ route: '/', attribution: { element: 'x'.repeat(4000) } });
    await b.flush('hidden');
    // 한꺼번에 내보낸 본문의 합이 64KiB를 넘지 않는다
    expect(Math.max(...inFlight)).toBeLessThanOrEqual(64 * 1024);
    expect(b.pending).toBeGreaterThan(0);
    const before = sent.length;
    await b.flush('interval');
    expect(b.pending).toBe(0);
    expect(sent.length).toBeGreaterThan(before);
    expect(sent.flatMap((s) => JSON.parse(s) as unknown[])).toHaveLength(40);
  });

  it('keepalive가 되는 브라우저에서 fetch가 실패하면 sendBeacon으로 다시 보내지 않고, keepalive가 안 되는 브라우저만 sendBeacon을 쓴다', async () => {
    const beacon = vi.fn(() => true);
    await sendBatch('/_t/rum', '[]', { fetch: vi.fn(async () => Promise.reject(new TypeError('끊김'))), sendBeacon: beacon, keepaliveSupported: true });
    expect(beacon).not.toHaveBeenCalled();
    const fetchFn = vi.fn();
    await sendBatch('/_t/rum', '[]', { fetch: fetchFn, sendBeacon: beacon, keepaliveSupported: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledWith('/_t/rum', '[]');
  });

  it('FE-T22 경로 틀은 고정 조각이 많은 틀을 먼저 고른다(동적 틀이 앞에 있어도)', () => {
    expect(routeTemplate('/events/new', ['/events/[id]', '/events/new'])).toBe('/events/new');
    expect(routeTemplate('/events/e1', ['/events/[id]', '/events/new'])).toBe('/events/[id]');
  });
});
