// A1V-09 core-svc 내부 회차 정산 경로의 공유 토큰 가드 회귀 시험.
// settlement-due는 종료된 모든 회차를 열거하므로 클러스터 안에서도 PEAKET_INTERNAL_TOKEN을 요구한다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
import { FakeIdentity, quiet } from './support.js';

const TOKEN = 'a1v-core-internal-token';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000101';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000301';

const config: EventSaleConfig = {
  eventId: EVENT,
  productionId: '0190f3a1-7c2e-7a00-8000-000000000201',
  promoterId: PROMOTER,
  rev: 7,
  opensAtMs: Date.parse('2026-11-01T11:00:00.000Z'),
  startsAtMs: Date.parse('2026-11-08T10:00:00.000Z'),
  lobbyMinutes: 10,
  lobbyShuffle: false,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: Date.parse('2026-11-08T09:00:00.000Z'),
  endsAtMs: Date.parse('2026-11-08T00:00:00.000Z'),
  commissionRateBp: 1000,
  salePolicy: [],
  eligGates: [],
  eligLists: [],
};

let svc: Awaited<ReturnType<typeof createService>>;
const originalToken = process.env.PEAKET_INTERNAL_TOKEN;

beforeAll(async () => {
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  const saleConfigs = new MemorySaleConfigStore();
  await saleConfigs.put([config], []);
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});

afterAll(async () => {
  await svc?.close();
  if (originalToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = originalToken;
});

describe('A1V-09 GET /internal/v1/events/settlement-due 공유 토큰', () => {
  test('토큰이 없거나 틀리면 403이고, 맞는 토큰이면 종료 회차를 돌려준다', async () => {
    const missing = await svc.http.inject({ method: 'GET', url: '/internal/v1/events/settlement-due?through=2026-11-14' });
    expect(missing.statusCode).toBe(403);

    const wrong = await svc.http.inject({ method: 'GET', url: '/internal/v1/events/settlement-due?through=2026-11-14', headers: { 'x-peaket-internal-token': 'wrong-token' } });
    expect(wrong.statusCode).toBe(403);

    const ok = await svc.http.inject({ method: 'GET', url: '/internal/v1/events/settlement-due?through=2026-11-14', headers: { 'x-peaket-internal-token': TOKEN } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toEqual({ items: [{ eventId: EVENT, promoterId: PROMOTER, endsAt: '2026-11-08T00:00:00.000Z' }] });

    const saleConfig = await svc.http.inject({ method: 'GET', url: `/internal/v1/events/${EVENT}/sale-config` });
    expect(saleConfig.statusCode).toBe(403);
  });
});
