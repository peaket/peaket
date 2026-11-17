// SEC-06R(W7-audit, R-628 회귀 시험 공백): 내부 판매 설정 경로의 가드(InternalToken401Guard)가 공용 InternalTokenGuard의
// 시작 차단(onModuleInit)과 상수 시간 비교(timingSafeEqual)를 그대로 쓰는지 서비스 시작 경계에서 본다.
// 정본: docs/architecture.md §3.2 'REST' 행(이 경로는 401, local·ci 밖 무토큰 시작 거절, 받은 값과 기대 값을 SHA-256 뒤 한 번 비교), asvs/settlement.md v5.0.0-11.2.4.
// W9-fix3 F2(시험 담당 w9f3-test, 2026-11-17): 옛 ④의 '길이가 다르면 timingSafeEqual 0번'은 정본이 바뀌어 '해시 32바이트 둘을 1번'으로 뒤집었다(시험 이의 아님).
// 기존 internal-sale-config-token.test.ts는 PEAKET_ENV=ci만 본다. 여기서는 INTERNAL_TOKEN_REQUIRED를 createService가 PEAKET_ENV로 넣게 해 prod·staging을 본다.
// timingSafeEqual 엿보기가 다른 시험 파일에 번지지 않게 이 파일에만 node:crypto 감싸기를 둔다(@peaket/platform은 원본으로 이어져 엿보기가 닿는다).
import 'reflect-metadata';
import { type DynamicModule, Module } from '@nestjs/common';
import { createService, INTERNAL_TOKEN, type PlatformService } from '@peaket/platform';
import { createHash, timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { MemorySaleConfigStore } from '../src/modules/catalog/adapters/memory-sale-config-store.js';
import type { EventSaleConfig } from '../src/modules/catalog/domain/event-sale-config.js';
import { SALE_CONFIG_READER } from '../src/modules/catalog/domain/sale-config-ports.js';
import { InternalSaleConfigController } from '../src/modules/catalog/inbound/internal-sale-config.controller.js';
import { quiet } from './support.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const spy = vi.mocked(timingSafeEqual);

const EVENT = '0190f3a1-7c2e-7a00-8000-000000000111';
const UNKNOWN = '0190f3a1-7c2e-7a00-8000-000000000999';
const TOKEN = 'boot-test-internal-token-0123456789';

const config: EventSaleConfig = {
  eventId: EVENT,
  productionId: '0190f3a1-7c2e-7a00-8000-000000000211',
  promoterId: '0190f3a1-7c2e-7a00-8000-000000000311',
  rev: 3,
  opensAtMs: Date.parse('2026-11-20T11:00:00.000Z'),
  startsAtMs: Date.parse('2026-12-24T10:00:00.000Z'),
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: Date.parse('2026-12-23T10:00:00.000Z'),
  salePolicy: [],
  eligGates: [],
  eligLists: [],
};

/** 내부 판매 설정 컨트롤러만 든 최소 모듈. 토큰은 INTERNAL_TOKEN 제공자로 준다(undefined·'' 포함) */
async function saleConfigModule(token: string | undefined): Promise<DynamicModule> {
  const store = new MemorySaleConfigStore();
  await store.put([config], []);
  @Module({
    controllers: [InternalSaleConfigController],
    providers: [
      { provide: SALE_CONFIG_READER, useValue: store },
      { provide: INTERNAL_TOKEN, useValue: token },
    ],
  })
  class SaleConfigOnlyModule {}
  return { module: SaleConfigOnlyModule };
}

// 운영 환경의 다른 필수 값(로그 가명 키)도 채워, 이 시험이 내부 토큰 게이트만 겨루게 한다(packages/platform/test/internal-token-boot.test.ts와 같다)
const LOG_KEY = Buffer.alloc(32, 7).toString('base64');

const boot = async (peaketEnv: string, token: string | undefined): Promise<PlatformService> =>
  createService({
    name: 'core-svc',
    module: await saleConfigModule(token),
    env: { PEAKET_ENV: peaketEnv, PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_PSEUDONYM_KEY: LOG_KEY },
    logDestination: quiet(),
  });

const get = (svc: PlatformService, eventId: string, token?: string) =>
  svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-config`, ...(token === undefined ? {} : { headers: { 'x-peaket-internal-token': token } }) });

describe('SEC-06R 내부 판매 설정 가드의 시작 차단', () => {
  test('SEC-06R ① prod·staging에서 토큰이 없거나 비면 내부 판매 설정 컨트롤러 조립이 시작하지 않는다', async () => {
    for (const env of ['prod', 'staging']) {
      for (const token of [undefined, '']) {
        const r = await boot(env, token).then(
          (svc): { svc: PlatformService } => ({ svc }),
          (err: Error): { err: Error } => ({ err }),
        );
        if ('svc' in r) {
          await r.svc.close().catch(() => undefined);
          throw new Error(`${env}에서 토큰 ${JSON.stringify(token ?? null)}로 내부 판매 설정 컨트롤러가 시작됐다`);
        }
        expect(r.err.message, `${env}·${JSON.stringify(token ?? null)}`).toMatch(/PEAKET_INTERNAL_TOKEN/);
      }
    }
  });

  test('SEC-06R ② local·ci에서는 토큰 없이 시작하고 요청이 통과한다', async () => {
    for (const env of ['local', 'ci']) {
      const svc = await boot(env, undefined);
      try {
        const ok = await get(svc, EVENT);
        expect(ok.statusCode, env).toBe(200);
        expect(JSON.parse(ok.payload)).toMatchObject({ eventId: EVENT, rev: 3 });
        expect((await get(svc, UNKNOWN)).statusCode, env).toBe(404);
      } finally {
        await svc.close().catch(() => undefined);
      }
    }
  });
});

describe('SEC-06R 운영 토큰 검사', () => {
  let svc: PlatformService;
  beforeAll(async () => {
    svc = await boot('prod', TOKEN);
  });
  afterAll(async () => {
    await svc?.close().catch(() => undefined);
  });

  test('SEC-06R ③ prod에서 토큰이 있으면 머리 없음·틀림·길이 다름은 401, 맞으면 200이다', async () => {
    const sameLengthWrong = `${TOKEN.slice(0, -1)}X`;
    expect(sameLengthWrong).toHaveLength(TOKEN.length);
    expect((await get(svc, EVENT)).statusCode).toBe(401);
    expect((await get(svc, EVENT, sameLengthWrong)).statusCode).toBe(401);
    expect((await get(svc, EVENT, `${TOKEN}-longer`)).statusCode).toBe(401);
    const ok = await get(svc, EVENT, TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toMatchObject({ eventId: EVENT });
    const due = await svc.http.inject({ method: 'GET', url: '/internal/v1/events/settlement-due?through=2026-11-15' });
    expect(due.statusCode).toBe(401);
  });

  test('W9F3 F2 SEC-06R ④ 내부 판매 설정 가드도 길이가 다른 토큰을 해시로 견주고 401이다 [ASVS v5.0.0-11.2.4]', async () => {
    const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const expectOneHashed = (given: string) => {
      expect(spy, given).toHaveBeenCalledTimes(1);
      const [a, b] = spy.mock.calls[0]!;
      expect(Buffer.isBuffer(a) && Buffer.isBuffer(b), given).toBe(true);
      expect([(a as Buffer).length, (b as Buffer).length], given).toEqual([32, 32]);
      expect([(a as Buffer).toString('hex'), (b as Buffer).toString('hex')], given).toEqual([sha256(given), sha256(TOKEN)]);
    };

    spy.mockClear();
    expect((await get(svc, EVENT, TOKEN)).statusCode).toBe(200);
    expectOneHashed(TOKEN);

    spy.mockClear();
    const sameLengthWrong = `X${TOKEN.slice(1)}`;
    expect((await get(svc, EVENT, sameLengthWrong)).statusCode).toBe(401);
    expectOneHashed(sameLengthWrong);

    // 길이가 다르면 옛 구현은 비교 없이 거절했다(이른 종료). 지금은 해시 둘을 한 번 견주고 401이다
    spy.mockClear();
    expect((await get(svc, EVENT, 'short')).statusCode).toBe(401);
    expectOneHashed('short');
  });
});
