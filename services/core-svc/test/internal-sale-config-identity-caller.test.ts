// identity-svc가 파트너 현장 스태프 초대의 회차 소유·유효 시간을 읽는 경로(BUILD_ORDER BAT-450B, ADR-0353).
// purchase·ticket·ops와 같은 읽기 전용 내부 HTTP GET /internal/v1/events/{eventId}/sale-config이고,
// identity는 promoterId·startsAtMs·endsAtMs·entryOpensAtMs만 쓴다. 응답 모양과 401/404를 여기서 고정한다.
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
import { FakeIdentity, quiet } from './support.js';

const EVENT = '0190f3a1-7c2e-7a00-8000-00000000b601';
const NO_ENTRY = '0190f3a1-7c2e-7a00-8000-00000000b602';
const UNKNOWN = '0190f3a1-7c2e-7a00-8000-00000000b699';
const TOKEN = 'bat450b-internal-token';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-00000000b701';
const STARTS = Date.parse('2026-12-24T10:00:00.000Z');
const ENDS = Date.parse('2026-12-24T12:00:00.000Z');
const ENTRY = Date.parse('2026-12-24T08:00:00.000Z');

const base: EventSaleConfig = {
  eventId: EVENT,
  productionId: '0190f3a1-7c2e-7a00-8000-00000000b801',
  promoterId: PROMOTER,
  rev: 3,
  opensAtMs: Date.parse('2026-11-24T10:00:00.000Z'),
  startsAtMs: STARTS,
  endsAtMs: ENDS,
  entryOpensAtMs: ENTRY,
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: Date.parse('2026-12-23T10:00:00.000Z'),
  salePolicy: [],
  eligGates: [],
  eligLists: [],
};

let svc: Awaited<ReturnType<typeof createService>>;
let previous: string | undefined;

beforeAll(async () => {
  previous = process.env.PEAKET_INTERNAL_TOKEN;
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  const saleConfigs = new MemorySaleConfigStore();
  await saleConfigs.put([base, { ...base, eventId: NO_ENTRY, entryOpensAtMs: null }], []);
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});

afterAll(async () => {
  await svc?.close();
  if (previous === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = previous;
});

const get = (eventId: string, token?: string) =>
  svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config`, ...(token === undefined ? { headers: { 'x-peaket-internal-token': TOKEN } } : token === '' ? {} : { headers: { 'x-peaket-internal-token': token } }) });

describe('identity가 읽는 내부 판매 설정 [I-T86 ①]', () => {
  test('I-T86 ① identity는 promoterId·startsAtMs·endsAtMs·entryOpensAtMs를 받고, 응답은 no-store다', async () => {
    const r = await get(EVENT);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ eventId: EVENT, promoterId: PROMOTER, startsAtMs: STARTS, endsAtMs: ENDS, entryOpensAtMs: ENTRY });
  });

  test('I-T86 ① entryOpensAtMs가 null인 옛 사본도 그대로 주고, 없는 회차는 404 not-found이며 토큰이 없으면 401이다', async () => {
    const nullEntry = await get(NO_ENTRY);
    expect(nullEntry.statusCode).toBe(200);
    expect(JSON.parse(nullEntry.payload)).toMatchObject({ eventId: NO_ENTRY, entryOpensAtMs: null });

    const missing = await get(UNKNOWN);
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.payload)).toMatchObject({ type: expect.stringContaining('not-found'), status: 404 });

    expect((await get(EVENT, '')).statusCode).toBe(401);
    expect((await get(EVENT, 'wrong')).statusCode).toBe(401);
  });
});
