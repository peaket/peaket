// purchase-svc가 회차 판매 설정 사본을 읽는 내부 HTTP 경로(BAT-051, HOT-252). core DB에 직접 접속하지 않게 core-svc가 대신 답한다.
// 200은 event_sale_config.payload 그대로(salePolicy·eligLists 포함), 없으면 404 not-found, 응답은 항상 no-store다.
import { createService } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
import { FakeIdentity, quiet } from './support.js';

const EVENT = '0190f3a1-7c2e-7a00-8000-000000000101';

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
  salePolicy: [{ version: 1, name: '팬클럽 선예매', rounds: 'ALL', rule: { then: { limitPerPerson: 2 } } }],
  eligGates: [],
  eligLists: ['lumen-fanclub-2026'],
};

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  const saleConfigs = new MemorySaleConfigStore();
  await saleConfigs.put([config], []);
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, saleConfigs }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});

afterAll(async () => {
  await svc.close();
});

const get = (eventId: string) => svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config` });

describe('GET /internal/v1/events/{eventId}/sale-config', () => {
  test('BAT051_ 판매 승인 사본을 salePolicy·eligLists까지 그대로 답하고 no-store다', async () => {
    const r = await get(EVENT);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toEqual(config);
  });

  test('BAT051_ 사본이 없는 회차는 404 not-found다(빈 설정을 만들지 않는다)', async () => {
    const r = await get('0190f3a1-7c2e-7a00-8000-000000000999');
    expect(r.statusCode).toBe(404);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ type: expect.stringContaining('not-found'), status: 404 });
  });
});
