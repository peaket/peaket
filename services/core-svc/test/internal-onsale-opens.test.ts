// core-svc 온세일 오픈 일정 내부 경로 GET /internal/v1/events/onsale-opens(TR-03, F-02-5 OPS-300,
// 계획 3.1·8.4·14절 10, ADR-0334 결정 3, C-T75 ①).
// - ops-svc의 HttpOnsaleScheduleSource가 부른다(서비스 사이 토큰). 구간은 [from, to)이고 취소된 회차는 뺀다.
// - 응답은 [{ eventId, opensAt(ISO), scale: LARGE|MEDIUM|SMALL|null }]뿐이다(개인정보·판매자·가격 없음).
// - 꼴이 틀리거나 from ≥ to면 400 invalid-query, 한 구간에 200건을 넘으면 잘린 목록 대신 400(구간을 좁혀 다시).
// 저장소는 SaleConfigStore 포트의 짝 가짜다(메모리 저장소의 규모·취소 판단을 시험이 직접 정한다).
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { DueEventConfig, SaleConfigStore } from '../src/modules/catalog/domain/sale-config-ports.js';
import { FakeIdentity, quiet } from './support.js';

const TOKEN = 'f025-core-onsale-opens-token';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.parse('2026-12-05T11:00:00.000Z');
const eventId = (n: number): string => `0190f25a-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;

interface Row {
  readonly eventId: string;
  readonly openAtMs: number;
  readonly scale: 'LARGE' | 'MEDIUM' | 'SMALL' | null;
  readonly cancelled?: boolean;
}

/** SaleConfigStore 짝 가짜: listOnsaleOpens만 실제로 답한다(나머지는 이 경로가 쓰지 않는다) */
class FakeSaleConfigs implements SaleConfigStore {
  constructor(private readonly rows: readonly Row[]) {}
  async put(): Promise<void> {}
  async get(): Promise<undefined> {
    return undefined;
  }
  async listEndedBefore(): Promise<DueEventConfig[]> {
    return [];
  }
  async commissionRateBp(): Promise<undefined> {
    return undefined;
  }
  async listOnsaleOpens(from: Date, to: Date, limit: number): Promise<readonly { eventId: string; opensAtMs: number; scale: Row['scale'] }[]> {
    return this.rows
      .filter((r) => r.cancelled !== true && r.openAtMs >= from.getTime() && r.openAtMs < to.getTime())
      .sort((a, b) => a.openAtMs - b.openAtMs || a.eventId.localeCompare(b.eventId))
      .slice(0, limit)
      .map((r) => ({ eventId: r.eventId, opensAtMs: r.openAtMs, scale: r.scale }));
  }
}

const EXACT = eventId(0xd01);
const INSIDE = eventId(0xd02);
const AT_END = eventId(0xd03);
const BEFORE = eventId(0xd04);
const CANCELLED = eventId(0xd05);
const ROWS: readonly Row[] = [
  { eventId: EXACT, openAtMs: T, scale: 'LARGE' },
  { eventId: INSIDE, openAtMs: T + 17 * MINUTE, scale: 'MEDIUM' },
  { eventId: AT_END, openAtMs: T + 2 * HOUR, scale: 'SMALL' },
  { eventId: BEFORE, openAtMs: T - 1, scale: null },
  { eventId: CANCELLED, openAtMs: T + 5 * MINUTE, scale: 'LARGE', cancelled: true },
];

let svc: Awaited<ReturnType<typeof createService>>;
let big: Awaited<ReturnType<typeof createService>>;
const originalToken = process.env.PEAKET_INTERNAL_TOKEN;
const auth = { 'x-peaket-internal-token': TOKEN };
const iso = (ms: number) => new Date(ms).toISOString();
const get = (s: typeof svc, query: string, headers: Record<string, string> = auth) =>
  s.http.inject({ method: 'GET', url: `/internal/v1/events/onsale-opens${query}`, headers });

beforeAll(async () => {
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs: new FakeSaleConfigs(ROWS) }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
  const many = Array.from({ length: 201 }, (_, i) => ({ eventId: eventId(0xe000 + i), openAtMs: T + i, scale: 'LARGE' as const }));
  big = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs: new FakeSaleConfigs(many) }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});

afterAll(async () => {
  await svc?.close();
  await big?.close();
  if (originalToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = originalToken;
});

describe('TR-03 core-svc 온세일 오픈 일정(계획 8.4)', () => {
  test('TR-03 ① 서비스 사이 토큰이 없거나 틀리면 401이고 목록을 주지 않는다', async () => {
    const q = `?from=${iso(T)}&to=${iso(T + HOUR)}`;
    const variants: Record<string, string>[] = [{}, { 'x-peaket-internal-token': 'wrong-token' }, { 'x-peaket-internal-token': `${TOKEN}x` }];
    for (const headers of variants) {
      const r = await get(svc, q, headers);
      expect(r.statusCode).toBe(401);
      expect(r.payload).not.toContain(EXACT);
    }
  });

  test('TR-03 ② [from, to)의 오픈만 회차·오픈 시각·규모 셋으로 주고, 취소 회차·끝 정각·시작 −1ms는 뺀다', async () => {
    const r = await get(svc, `?from=${iso(T)}&to=${iso(T + HOUR)}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as { items: Record<string, unknown>[] };
    expect(body).toEqual({
      items: [
        { eventId: EXACT, opensAt: iso(T), scale: 'LARGE' },
        { eventId: INSIDE, opensAt: iso(T + 17 * MINUTE), scale: 'MEDIUM' },
      ],
    });
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(['eventId', 'opensAt', 'scale']);
    for (const leaked of ['title', 'promoter', 'production', 'commission', 'price']) expect(r.payload).not.toContain(leaked);

    // 끝 정각은 들지 않고, 끝을 1ms 늘리면 든다
    const atEnd = JSON.parse((await get(svc, `?from=${iso(T)}&to=${iso(T + 2 * HOUR)}`)).payload) as { items: { eventId: string }[] };
    expect(atEnd.items.map((i) => i.eventId)).toEqual([EXACT, INSIDE]);
    const wider = JSON.parse((await get(svc, `?from=${iso(T)}&to=${iso(T + 2 * HOUR + 1)}`)).payload) as { items: { eventId: string }[] };
    expect(wider.items.map((i) => i.eventId)).toEqual([EXACT, INSIDE, AT_END]);
    const earlier = JSON.parse((await get(svc, `?from=${iso(T - 1)}&to=${iso(T)}`)).payload) as { items: { eventId: string }[] };
    expect(earlier.items.map((i) => i.eventId)).toEqual([BEFORE]);
  });

  test('TR-03 ③ 구간이 없거나 꼴이 틀리거나 뒤바뀌면 400 invalid-query다', async () => {
    const from = T;
    for (const q of [
      '',
      `?from=${iso(from)}`,
      `?to=${iso(from + HOUR)}`,
      `?from=2026-12-05&to=${iso(from + HOUR)}`,
      `?from=${iso(from)}&to=${encodeURIComponent('2026-12-05T13:00:00+09:00')}`,
      `?from=${iso(from)}&to=${iso(from)}`,
      `?from=${iso(from + HOUR)}&to=${iso(from)}`,
    ]) {
      const r = await get(svc, q);
      expect(r.statusCode, q).toBe(400);
      expect(JSON.parse(r.payload).type, q).toMatch(/invalid-query$/);
    }
  });

  test('TR-03 ④ 한 구간에 200건을 넘으면 잘린 목록 대신 400이고, 200건이면 모두 준다', async () => {
    const over = await get(big, `?from=${iso(T)}&to=${iso(T + HOUR)}`);
    expect(over.statusCode).toBe(400);
    expect(JSON.parse(over.payload).type).toMatch(/invalid-query$/);
    expect(over.payload).not.toContain(eventId(0xe000));

    const exact = await get(big, `?from=${iso(T)}&to=${iso(T + 200)}`);
    expect(exact.statusCode).toBe(200);
    const items = (JSON.parse(exact.payload) as { items: { eventId: string; opensAt: string; scale: string }[] }).items;
    expect(items).toHaveLength(200);
    expect(items[0]).toEqual({ eventId: eventId(0xe000), opensAt: iso(T), scale: 'LARGE' });
    expect(items.at(-1)).toEqual({ eventId: eventId(0xe000 + 199), opensAt: iso(T + 199), scale: 'LARGE' });
  });
});
