// BAT-173 T10: identity-svc가 파트너 테넌트당 600회/분 공용 가드를 조립하는지(D-T50 ⑦, docs/api/guidelines.md §6 '조립과 시작').
// 두 층으로 본다: (1) 시작 파일 src/main.ts가 세션·캐시 Redis(PEAKET_IDENTITY_REDIS_URL로 만든 cache)를 tenantRateLimit으로 넘기는지 소스 경계로,
// (2) 그 조립으로 선 서비스가 파트너 요청만 한도 Redis로 세고 tenant_rate_limit_total{service="identity-svc",result}에 붙는지 실제 createService로.
// 같은 프로세스의 gRPC GetAdminAuthz는 HTTP 가드를 지나지 않아 세지 않는다(계획 §8). local·ci 밖에서 가드가 없으면 시작이 실패한다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Controller, Get, Module } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  Roles,
  createService,
  fakeClock,
  type AdminAuthz,
  type AdminAuthzPort,
  type HotRedis,
  type Principal,
} from '@peaket/platform';

const SERVICE = 'identity-svc';
const SOURCE = new URL('../src/main.ts', import.meta.url);

@Controller('v1/partner')
@Roles(['partner_admin', 'partner_member'])
class PartnerController {
  @Get('ping')
  ping(@CurrentPrincipal() p: Principal) {
    return { tenantId: p.tenantId };
  }
}

@Controller('v1/fan')
class FanController {
  @Get('ping')
  @Roles(['fan'])
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PartnerController, FanController] })
class WiringModule {}

class FakeIdentity implements AdminAuthzPort {
  async getAdminAuthz(_q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return { valid: true, role: 'partner_admin', tenantId: 'tenant-a' };
  }
}

/** evalScript 하나만 있는 가짜 Redis(한도 호출 수를 센다) */
class FakeRedis {
  calls: string[] = [];
  async evalScript(_script: unknown, keys: string[]): Promise<unknown> {
    this.calls.push(keys[0] ?? '');
    return [1, 60_000];
  }
}

function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const m = /^([^{\s]+)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = Object.fromEntries([...(m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => got[k] === v)) return Number(m[3]);
  }
  return undefined;
}

const started: Awaited<ReturnType<typeof createService>>[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

const KEY = Buffer.alloc(32, 3).toString('base64');

async function boot(o: { env?: Record<string, string>; tenantRateLimit?: { redis: HotRedis } } = {}) {
  const svc = await createService({
    name: SERVICE,
    module: WiringModule,
    env: o.env ?? { PEAKET_ENV: 'ci' },
    clock: fakeClock(),
    adminAuthz: new FakeIdentity(),
    ...(o.tenantRateLimit ? { tenantRateLimit: o.tenantRateLimit } : {}),
  });
  started.push(svc);
  return svc;
}

const partner = { 'x-user-id': 'acc-a1', 'x-session-id': 's-a1', 'x-user-aud': 'partner' };
const fan = { 'x-user-id': 'acc-fan', 'x-session-id': 's-fan', 'x-user-aud': 'fan' };

describe('identity-svc 테넌트 한도 조립(D-T50 ⑦)', () => {
  test('D-T50 ⑦ 시작 파일이 cache(PEAKET_IDENTITY_REDIS_URL)를 tenantRateLimit으로 넘긴다', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(source).toContain('PEAKET_IDENTITY_REDIS_URL');
    expect(source).toMatch(/tenantRateLimit:\s*\{\s*redis:\s*cache\s*\}/);
  });

  test('D-T50 ⑦ 파트너 요청만 한도 Redis를 부르고 팬 요청은 부르지 않으며 지표에 service=identity-svc로 붙는다', async () => {
    const redis = new FakeRedis();
    const svc = await boot({ tenantRateLimit: { redis: redis as unknown as HotRedis } });
    expect((await svc.http.inject({ method: 'GET', url: '/v1/partner/ping', headers: partner })).statusCode).toBe(200);
    expect(redis.calls).toEqual(['rl:tenant:tenant-a']);
    expect((await svc.http.inject({ method: 'GET', url: '/v1/fan/ping', headers: fan })).statusCode).toBe(200);
    expect(redis.calls).toHaveLength(1);
    const text = (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload as unknown as string;
    expect(sample(text, 'tenant_rate_limit_total', { service: SERVICE, result: 'allowed' })).toBe(1);
  });

  test('D-T50 ⑦ local·ci 밖에서 파트너 처리기가 있는데 가드가 없으면 시작하지 않는다', async () => {
    const prod = { PEAKET_ENV: 'prod', PEAKET_LOG_PSEUDONYM_KEY: KEY };
    await expect(boot({ env: prod })).rejects.toThrow(/tenantRateLimit/);
    for (const env of ['local', 'ci']) {
      const svc = await boot({ env: { PEAKET_ENV: env } });
      expect(svc.name, env).toBe(SERVICE);
    }
  });
});
