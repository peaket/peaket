// 브라우저 지표 묶음 시험(docs/frontend.md §5.16, FE-T22: 64KiB, 식별값·쿼리·조각 없음, 표본, BUILD_ORDER BAS-210).
// 묶음의 사건은 계약 asyncapi RumSample(판 2)을 지켜야 한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RumSample } from '@peaket/contracts/asyncapi';
import { createRumBatcher, routeTemplate, MAX_BATCH_BYTES, sendBatch } from '../src/lite';
import { traceparent } from '../src/full';

afterEach(() => vi.restoreAllMocks());

const ROUTES = ['/events/[id]', '/booking/[eventId]/seats', '/my/tickets/[ticketId]', '/'];

describe('경로 템플릿', () => {
  it('FE-T22 실제 주소를 경로 템플릿으로 바꾸고 쿼리·조각·식별값을 싣지 않는다', () => {
    expect(routeTemplate('/events/evt-lumen-1025?ref=mail#top', ROUTES)).toBe('/events/[id]');
    expect(routeTemplate('https://www.peaket.example/booking/evt-1/seats?x=1', ROUTES)).toBe('/booking/[eventId]/seats');
    expect(routeTemplate('/my/tickets/0198f4a2-5c1e-7000-8000-000000000001', ROUTES)).toBe('/my/tickets/[ticketId]');
    expect(routeTemplate('/', ROUTES)).toBe('/');
    // 모르는 주소는 그 값을 싣지 않고 하나로 묶는다
    expect(routeTemplate('/some/user-42/secret', ROUTES)).toBe('(unknown)');
  });
});

describe('묶음', () => {
  const sample = (i: number) => ({ route: '/events/[id]', metrics: { lcp: 1.2 + i / 1000 }, errors: { count: 0 } });

  it('FE-T22 묶음의 사건은 계약 RumSample을 지키고 표본 비율·앱·배포 식별자를 싣는다', async () => {
    const sent: string[] = [];
    const b = createRumBatcher({ app: 'web', routes: ROUTES, dpl: 'abc123', sampleRate: 0.1, send: async (body) => void sent.push(body), deviceClass: () => 'mobile', navType: () => 'navigate' });
    b.add(sample(1));
    await b.flush('hidden');
    expect(sent).toHaveLength(1);
    const events = JSON.parse(sent[0]!) as unknown[];
    expect(events).toHaveLength(1);
    const e = RumSample.parse(events[0]);
    expect(e).toMatchObject({ schemaVersion: 2, app: 'web', dpl: 'abc123', sampleRate: 0.1, route: '/events/[id]', deviceClass: 'mobile', navType: 'navigate' });
    expect(e.eventKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('FE-T22 묶음 하나는 64KiB 이하로 나눠 보낸다', async () => {
    const sent: string[] = [];
    const b = createRumBatcher({ app: 'partner', routes: ROUTES, send: async (body) => void sent.push(body) });
    const big = { route: '/events/[id]', attribution: { element: 'x'.repeat(4000) } };
    for (let i = 0; i < 40; i++) b.add(big);
    await b.flush('interval');
    expect(sent.length).toBeGreaterThan(1);
    for (const body of sent) expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(sent.flatMap((s) => JSON.parse(s) as unknown[])).toHaveLength(40);
  });

  it('FE-T22 혼자서 64KiB를 넘는 사건은 보내지 않고 버린다', async () => {
    const sent: string[] = [];
    const b = createRumBatcher({ app: 'web', routes: ROUTES, send: async (body) => void sent.push(body) });
    b.add({ route: '/', attribution: { element: 'x'.repeat(70_000) } });
    await b.flush('interval');
    expect(sent).toHaveLength(0);
    expect(b.dropped).toBe(1);
  });

});

describe('보내기', () => {
  it('fetch keepalive·쿠키 없음으로 보내고, keepalive가 안 되면 sendBeacon을 쓴다', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await sendBatch('/_t/rum', '[]', { fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledWith('/_t/rum', expect.objectContaining({ method: 'POST', keepalive: true, credentials: 'omit' }));
    const beacon = vi.fn(() => true);
    await sendBatch('/_t/rum', '[]', { fetch: vi.fn(async () => Promise.reject(new TypeError('keepalive 안 됨'))), sendBeacon: beacon });
    expect(beacon).toHaveBeenCalledWith('/_t/rum', '[]');
  });
});

describe('추적 머리', () => {
  it('traceparent는 표본 표시 00의 W3C 꼴이고 매번 새로 만든다', () => {
    const a = traceparent();
    expect(a).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(traceparent()).not.toBe(a);
    expect(a).not.toMatch(/^00-0{32}-/);
  });
});

describe('새 맥락 리뷰 재현(BAS-210)', () => {
  it('FE-T22 화면이 넘긴 원인 정보에서 주소·항목 객체를 빼고 선택자·숫자만 싣고, 공통 칸을 덮어쓰지 못한다', async () => {
    const sent: string[] = [];
    const b = createRumBatcher({ app: 'web', routes: ROUTES, send: async (body) => void sent.push(body), uuid: () => '00000000-0000-4000-8000-000000000000' });
    b.add({
      route: '/events/[id]',
      metrics: { lcp: 1.1 },
      attribution: {
        element: 'main>img.hero',
        url: 'https://img.peaket.example/a.avif?token=secret',
        navigationEntry: { name: 'https://www.peaket.example/events/1?ref=mail' },
        interactionTarget: 'https://evil.example/?q=1',
        inputDelay: 12,
      },
      // @ts-expect-error 공통 칸을 덮어쓰려는 값
      app: 'console',
      eventKey: 'x',
    });
    await b.flush('hidden');
    const e = (JSON.parse(sent[0]!) as Array<Record<string, unknown>>)[0]!;
    expect(e.app).toBe('web');
    expect(e.eventKey).toBe('00000000-0000-4000-8000-000000000000');
    expect(e.attribution).toEqual({ element: 'main>img.hero', inputDelay: 12 });
    expect(sent[0]).not.toMatch(/token=|ref=mail|evil/);
  });

  it('FE-T22 route는 앱의 경로 틀 목록에 있는 값만 싣고, 실제 주소는 그 틀로 바꾸며, 맞는 틀이 없으면 (unknown)이다', async () => {
    const sent: string[] = [];
    const b = createRumBatcher({ app: 'web', routes: ROUTES, send: async (body) => void sent.push(body) });
    for (const route of ['/events/[id]', '/events/lumen-tour', '/u/kimchulsoo', '/events/evt-1?ref=x']) b.add({ route });
    await b.flush('hidden');
    expect((JSON.parse(sent[0]!) as Array<{ route: string }>).map((e) => e.route)).toEqual(['/events/[id]', '/events/[id]', '(unknown)', '/events/[id]']);
  });
});
