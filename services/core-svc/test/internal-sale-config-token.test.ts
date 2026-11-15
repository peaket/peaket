// SEC-06 회귀: 내부 판매 설정 HTTP는 토큰 검사를 먼저 하고, 없거나 틀리면 401이다.
// 사본이 없는 회차라도 인증 전에는 404를 돌려주지 않는다(경로 존재·설정 유무를 먼저 흘리지 않는다).
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
import { FakeIdentity, quiet } from './support.js';

const EVENT = '0190f3a1-7c2e-7a00-8000-000000000101';
const UNKNOWN = '0190f3a1-7c2e-7a00-8000-000000000999';
const TOKEN = 'internal-token-for-sale-config-regression';

const config: EventSaleConfig = {
  eventId: EVENT,
  productionId: '0190f3a1-7c2e-7a00-8000-000000000201',
  promoterId: '0190f3a1-7c2e-7a00-8000-000000000301',
  rev: 7,
  opensAtMs: Date.parse('2026-11-20T11:00:00.000Z'),
  startsAtMs: Date.parse('2026-12-24T10:00:00.000Z'),
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: Date.parse('2026-12-23T10:00:00.000Z'),
  layoutVersion: 3,
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
  await saleConfigs.put([config], []);
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});

afterAll(async () => {
  await svc?.close();
  if (previous === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = previous;
});

const get = (eventId: string, token?: string) =>
  svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config`, ...(token === undefined ? {} : { headers: { 'x-peaket-internal-token': token } }) });

describe('SEC-06 내부 판매 설정 토큰', () => {
  test('토큰이 없으면 사본이 없는 회차도 401이고 404로 존재 여부를 흘리지 않는다', async () => {
    expect((await get(UNKNOWN)).statusCode).toBe(401);
    expect((await get(EVENT)).statusCode).toBe(401);
  });

  test('틀린 토큰(길이·접두사·접미사)은 401이다', async () => {
    expect((await get(EVENT, 'short')).statusCode).toBe(401);
    expect((await get(EVENT, TOKEN.slice(0, -1))).statusCode).toBe(401);
    expect((await get(EVENT, `${TOKEN}x`)).statusCode).toBe(401);
  });

  test('맞는 토큰은 200이고, 같은 컨트롤러의 정산 대상 경로도 토큰 없이는 401이다', async () => {
    const ok = await get(EVENT, TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toMatchObject({ eventId: EVENT, promoterId: config.promoterId });
    const due = await svc.http.inject({ method: 'GET', url: '/internal/v1/events/settlement-due?through=2026-11-15' });
    expect(due.statusCode).toBe(401);
  });
});
