// 끝난 온세일 회차 목록 내부 경로 GET /internal/v1/events/onsale-closed(BAT-360 리뷰 RV-02, ADR-0348 결정 9, 감독 결정 2026-11-22).
// 정본 값: ops-svc 게시 작업 audit-anchor만 부르는 읽기 전용 경로이고, 판매 시작 + 60분(온세일 윈도우 끝)이 구간 closedFrom·closedTo에 든 회차의
// ID와 마감 시각만 준다(개인정보·판매자·가격 없음). 서비스 사이 토큰, 하루 [가정] 구간·500행 [가정] 상한(넘으면 400, 잘린 목록을 주지 않는다).
// 구간 끝은 부르는 쪽 포트(ClosedOnsaleSource.closedBetween, '[fromMs, toMs)')와 같게 시작 포함·끝 제외로 본다.
// 저장소는 core-svc 메모리 짝 가짜 MemorySaleConfigStore(SaleConfigStore·SaleConfigReader 포트 구현)다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
import { FakeIdentity, quiet } from './support.js';

const TOKEN = 'b360-core-onsale-closed-token';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 판매 시작 T. 온세일 윈도우 끝(마감)은 T + 60분이다(ADR-0348 결정 9, control-tower §3 명령 12 'T-10분~T+60분') */
const T = Date.parse('2026-11-25T11:00:00.000Z');
const CLOSED_AT = T + 60 * MINUTE;
const PRODUCTION = '0190f3a1-7c2e-7a00-8000-000000000b21';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000b31';

const eventId = (n: number): string => `0190f3a1-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;
const configOf = (id: string, opensAtMs: number): EventSaleConfig => ({
  eventId: id,
  productionId: PRODUCTION,
  promoterId: PROMOTER,
  title: '판매자 회차 이름',
  rev: 3,
  opensAtMs,
  startsAtMs: opensAtMs + 7 * 24 * HOUR,
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: false,
  perPersonLimit: 4,
  saleEndsAtMs: opensAtMs + 6 * 24 * HOUR,
  commissionRateBp: 1100,
  pgKey: 'toss-main',
  pgTps: 123,
  salePolicy: [],
  eligGates: [],
  eligLists: [],
});

const EXACT = eventId(0xb01); // 마감 = 구간 시작 정각(든다)
const INSIDE = eventId(0xb02); // 구간 안
const AT_END = eventId(0xb03); // 마감 = 구간 끝 정각(들지 않는다)
const BEFORE = eventId(0xb04); // 구간 시작 − 1ms(들지 않는다)

let svc: Awaited<ReturnType<typeof createService>>;
let big: Awaited<ReturnType<typeof createService>>;
const originalToken = process.env.PEAKET_INTERNAL_TOKEN;
const auth = { 'x-peaket-internal-token': TOKEN };
const get = (s: typeof svc, query: string, headers: Record<string, string> = auth) => s.http.inject({ method: 'GET', url: `/internal/v1/events/onsale-closed${query}`, headers });
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  const saleConfigs = new MemorySaleConfigStore();
  await saleConfigs.put([configOf(EXACT, T), configOf(INSIDE, T + 17 * MINUTE), configOf(AT_END, T + 2 * HOUR), configOf(BEFORE, T - 1)], []);
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
  // 한 구간에 501개(상한 500 + 1)가 드는 저장소
  const many = new MemorySaleConfigStore();
  await many.put(
    Array.from({ length: 501 }, (_, i) => configOf(eventId(0xc000 + i), T + i)),
    [],
  );
  big = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs: many }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});

afterAll(async () => {
  await svc?.close();
  await big?.close();
  if (originalToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = originalToken;
});

describe('B360-CORE 끝난 온세일 회차 목록(ADR-0348 결정 9)', () => {
  test('B360-CORE ① 서비스 사이 토큰이 없거나 틀리면 401이고 목록을 주지 않는다', async () => {
    const q = `?closedFrom=${iso(CLOSED_AT)}&closedTo=${iso(CLOSED_AT + HOUR)}`;
    const variants: Record<string, string>[] = [{}, { 'x-peaket-internal-token': 'wrong-token' }, { 'x-peaket-internal-token': `${TOKEN}x` }];
    for (const headers of variants) {
      const r = await get(svc, q, headers);
      expect(r.statusCode).toBe(401);
      expect(r.payload).not.toContain(EXACT);
    }
  });

  test('B360-CORE ② 판매 시작 + 60분이 [closedFrom, closedTo)에 든 회차만 회차 ID·마감 시각 두 칸으로 주고, 시작 정각은 들고 끝 정각·시작 − 1ms는 들지 않는다', async () => {
    const r = await get(svc, `?closedFrom=${iso(CLOSED_AT)}&closedTo=${iso(CLOSED_AT + 2 * HOUR)}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as { items: Record<string, unknown>[] };
    expect(body).toEqual({
      items: [
        { eventId: EXACT, closedAt: iso(CLOSED_AT) },
        { eventId: INSIDE, closedAt: iso(CLOSED_AT + 17 * MINUTE) },
      ],
    });
    // 개인정보·판매자·가격·결제 칸이 없다(응답 칸은 둘뿐)
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(['closedAt', 'eventId']);
    for (const leaked of [PROMOTER, PRODUCTION, '판매자 회차 이름', 'toss-main', 'commissionRateBp', 'perPersonLimit']) expect(r.payload).not.toContain(leaked);
    // 끝을 1ms 늘리면 끝 정각이던 회차가 든다
    const wider = JSON.parse((await get(svc, `?closedFrom=${iso(CLOSED_AT)}&closedTo=${iso(CLOSED_AT + 2 * HOUR + 1)}`)).payload) as { items: { eventId: string }[] };
    expect(wider.items.map((i) => i.eventId)).toEqual([EXACT, INSIDE, AT_END]);
    const earlier = JSON.parse((await get(svc, `?closedFrom=${iso(CLOSED_AT - 1)}&closedTo=${iso(CLOSED_AT)}`)).payload) as { items: { eventId: string }[] };
    expect(earlier.items.map((i) => i.eventId)).toEqual([BEFORE]);
  });

  test('B360-CORE ③ 구간이 없거나 꼴이 틀리거나 뒤바뀌었거나 하루를 넘으면 400이고, 정확히 하루는 받는다', async () => {
    const from = CLOSED_AT;
    const bad = [
      '',
      `?closedFrom=${iso(from)}`,
      `?closedTo=${iso(from + HOUR)}`,
      `?closedFrom=2026-11-25&closedTo=${iso(from + HOUR)}`,
      `?closedFrom=${iso(from)}&closedTo=${encodeURIComponent('2026-11-25T13:00:00+09:00')}`,
      `?closedFrom=${iso(from)}&closedTo=${iso(from)}`,
      `?closedFrom=${iso(from + HOUR)}&closedTo=${iso(from)}`,
      `?closedFrom=${iso(from)}&closedTo=${iso(from + 24 * HOUR + 1)}`,
    ];
    for (const q of bad) {
      const r = await get(svc, q);
      expect(r.statusCode, q).toBe(400);
      expect(JSON.parse(r.payload).type, q).toMatch(/invalid-query$/);
    }
    expect((await get(svc, `?closedFrom=${iso(from)}&closedTo=${iso(from + 24 * HOUR)}`)).statusCode).toBe(200);
  });

  test('B360-CORE ④ 한 구간에 500행을 넘으면 잘린 목록 대신 400(구간을 좁혀 다시)이고, 500행이면 모두 준다', async () => {
    const over = await get(big, `?closedFrom=${iso(CLOSED_AT)}&closedTo=${iso(CLOSED_AT + HOUR)}`);
    expect(over.statusCode).toBe(400);
    expect(JSON.parse(over.payload).type).toMatch(/invalid-query$/);
    expect(over.payload).not.toContain(eventId(0xc000));
    // 마지막 회차(마감 = CLOSED_AT + 500ms)를 구간 끝으로 빼면 정확히 500행
    const exact = await get(big, `?closedFrom=${iso(CLOSED_AT)}&closedTo=${iso(CLOSED_AT + 500)}`);
    expect(exact.statusCode).toBe(200);
    const items = (JSON.parse(exact.payload) as { items: { eventId: string; closedAt: string }[] }).items;
    expect(items).toHaveLength(500);
    expect(items[0]).toEqual({ eventId: eventId(0xc000), closedAt: iso(CLOSED_AT) });
    expect(items.at(-1)).toEqual({ eventId: eventId(0xc000 + 499), closedAt: iso(CLOSED_AT + 499) });
  });
});
