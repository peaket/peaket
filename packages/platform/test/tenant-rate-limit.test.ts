// BAT-173 파트너 API 테넌트당 600회/분 공용 가드(D-T50 ⑦, docs/api/guidelines.md §6, docs/data.md §3·§5).
// 시험 담당 2026-11-20. 단위(가짜 Redis)에서 키 모양·600/601 경계·Lua 한 번·첫 증가 PEXPIRE·Retry-After·열림(20ms 마감·연결·답 모양 오류)을 보고,
// 가드 조립(createService)에서 파트너 역할만 세는지·인가 앞에서 세지 않는지·x-tenant-id를 믿지 않는지·지표 라벨을 본다.
// 600·60초·20ms는 코드 상수에서 가져오지 않고 정본 값으로 적는다(계획 §14 '시험 값이 코드 상수와 같지 않게').
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  Roles,
  TENANT_RATE_LIMIT_PER_MINUTE,
  TENANT_RATE_LIMIT_TIMEOUT_MS,
  TENANT_RATE_LIMIT_WINDOW_MS,
  createService,
  fakeClock,
  redisTenantRateLimiter,
  tenantRateLimitKey,
  type AdminAuthz,
  type AdminAuthzPort,
  type HotRedis,
  type Principal,
  type RedisScript,
  type TenantRateLimitResult,
} from '../src/index.js';

interface Call {
  script: RedisScript;
  keys: string[];
  args: string[];
  deadlineMs?: number;
}

/** evalScript 하나만 있는 가짜 Redis. 답·오류·마감을 시험마다 바꾼다 */
class FakeRedis {
  readonly calls: Call[] = [];
  reply: unknown = [1, 60_000];
  outcome: 'reply' | 'throw' | 'hang' = 'reply';
  async evalScript(script: RedisScript, keys: string[], args: string[], o?: { deadlineMs?: number }): Promise<unknown> {
    this.calls.push({ script, keys, args, ...(o?.deadlineMs === undefined ? {} : { deadlineMs: o.deadlineMs }) });
    if (this.outcome === 'throw') throw new Error('READONLY You cannot write against a read only replica');
    if (this.outcome === 'hang') {
      // HotRedis 계약대로 호출 쪽 마감을 지키지 못한 상황을 흉내 낸다(마감이 없으면 시험이 매달리므로 100ms로 끊는다)
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('deadline')), o?.deadlineMs ?? 100));
    }
    return this.reply;
  }
}

/** Prometheus 글에서 이름·라벨이 맞는 값(없으면 undefined) */
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

describe('테넌트 한도 키·상수(정본 값)', () => {
  test('D-T50 ⑦ 키는 rl:tenant:테넌트ID 하나이고 계정·서비스·경로를 넣지 않는다', () => {
    expect(tenantRateLimitKey('3f1a6f8e-1111-4c2a-9e55-1d2a3b4c5d6e')).toBe('rl:tenant:3f1a6f8e-1111-4c2a-9e55-1d2a3b4c5d6e');
    expect(tenantRateLimitKey('tenant-a')).toBe('rl:tenant:tenant-a');
  });

  test('D-T50 ⑦ 한도는 600회/분, 창은 60초, 판정 마감은 20ms다', () => {
    expect(TENANT_RATE_LIMIT_PER_MINUTE).toBe(600);
    expect(TENANT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(TENANT_RATE_LIMIT_TIMEOUT_MS).toBe(20);
  });
});

describe('600/601 경계와 Lua 원자 연산', () => {
  test('D-T50 ⑦ 600번째는 통과하고 601번째만 429다', async () => {
    let n = 0;
    const limiter = redisTenantRateLimiter({
      redis: {
        evalScript: async () => {
          n += 1;
          return [n, 60_000];
        },
      },
    });
    for (let i = 1; i <= 600; i++) expect(await limiter.check('tenant-a'), `${i}번째`).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.check('tenant-a'), '601번째').toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(await limiter.check('tenant-a'), '602번째').toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  test('D-T50 ⑦ 요청마다 Lua를 한 번만 부르고 INCR·PTTL·첫 증가 PEXPIRE가 같은 스크립트에 있다', async () => {
    const redis = new FakeRedis();
    const limiter = redisTenantRateLimiter({ redis });
    await limiter.check('tenant-a');
    await limiter.check('tenant-a');
    expect(redis.calls).toHaveLength(2);
    for (const call of redis.calls) {
      expect(call.keys).toEqual(['rl:tenant:tenant-a']);
      expect(call.args).toEqual(['60000']);
      expect(call.deadlineMs).toBe(20);
      expect(call.script.source).toContain("redis.call('INCR', KEYS[1])");
      expect(call.script.source).toContain("redis.call('PTTL', KEYS[1])");
      expect(call.script.source).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
    }
  });

  test('D-T50 ⑦ 판정 마감은 넘겨 받은 값(기본 20ms)이고 답이 없으면 통과하며 unavailable로 센다', async () => {
    const redis = new FakeRedis();
    redis.outcome = 'hang';
    const results: TenantRateLimitResult[] = [];
    const limiter = redisTenantRateLimiter({ redis, onResult: (r) => results.push(r) });
    const started = performance.now();
    await expect(limiter.check('tenant-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(performance.now() - started).toBeLessThan(500);
    expect(redis.calls[0]?.deadlineMs).toBe(20);
    expect(results).toEqual(['unavailable']);
  });

  test('D-T50 ⑦ Redis 연결·스크립트 오류는 5xx가 아니라 열림이고 unavailable로 센다', async () => {
    const redis = new FakeRedis();
    redis.outcome = 'throw';
    const results: TenantRateLimitResult[] = [];
    const limiter = redisTenantRateLimiter({ redis, onResult: (r) => results.push(r) });
    await expect(limiter.check('tenant-a')).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(results).toEqual(['unavailable']);
  });

  test('D-T50 ⑦ Lua 답 모양이 틀리면(널·빈 배열·글자·음수) 열림이고 unavailable로 센다', async () => {
    for (const reply of [null, undefined, [], [1], ['x', 1], { 0: 1, 1: 60_000 }, [-1, 60_000], [1.5, 60_000]]) {
      const redis = new FakeRedis();
      redis.reply = reply;
      const results: TenantRateLimitResult[] = [];
      const limiter = redisTenantRateLimiter({ redis, onResult: (r) => results.push(r) });
      expect(await limiter.check('tenant-a'), JSON.stringify(reply)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      expect(results, JSON.stringify(reply)).toEqual(['unavailable']);
    }
  });

  test('D-T50 ⑦ 빈 테넌트 ID는 Redis를 부르지 않고 통과한다', async () => {
    const redis = new FakeRedis();
    const limiter = redisTenantRateLimiter({ redis });
    expect(await limiter.check('')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(redis.calls).toHaveLength(0);
  });
});

describe('Retry-After는 남은 창의 초(1~60)', () => {
  test('D-T50 ⑦ PTTL을 올림해 1~60초로 주고 창 길이를 넘지 않는다', async () => {
    const cases: [number, number][] = [
      [25_000, 25],
      [1, 1],
      [0, 1],
      [-2, 1],
      [59_001, 60],
      [60_000, 60],
      [120_000, 60],
    ];
    for (const [ttl, want] of cases) {
      const redis = new FakeRedis();
      redis.reply = [601, ttl];
      const limiter = redisTenantRateLimiter({ redis });
      expect(await limiter.check('tenant-a'), `PTTL ${ttl}`).toEqual({ allowed: false, retryAfterSeconds: want });
    }
  });

  test('D-T50 ⑦ 통과한 요청의 Retry-After는 0이고 지표는 allowed·limited로 갈린다', async () => {
    const redis = new FakeRedis();
    const results: TenantRateLimitResult[] = [];
    const limiter = redisTenantRateLimiter({ redis, onResult: (r) => results.push(r) });
    redis.reply = [600, 30_000];
    expect(await limiter.check('tenant-a')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    redis.reply = [601, 30_000];
    expect(await limiter.check('tenant-a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(results).toEqual(['allowed', 'limited']);
  });

  test('D-T50 ⑦ 한도·창·마감을 바꿔 넘기면 그 값으로 판정한다', async () => {
    const redis = new FakeRedis();
    redis.reply = [3, 1_500];
    const limiter = redisTenantRateLimiter({ redis, limit: 2, windowMs: 1_500, timeoutMs: 5 });
    expect(await limiter.check('tenant-a')).toEqual({ allowed: false, retryAfterSeconds: 2 });
    expect(redis.calls[0]?.args).toEqual(['1500']);
    expect(redis.calls[0]?.deadlineMs).toBe(5);
  });
});

// ---- 가드 조립: 파트너 역할만 세고, 신원·역할 판정 뒤에 센다(계획 §14 '센 뒤에 인가하지 않는다') ----

@Controller('v1/limit')
@Roles(['partner_admin', 'partner_member'])
class PartnerController {
  @Get('ping')
  ping(@CurrentPrincipal() p: Principal) {
    return { tenantId: p.tenantId, role: p.role };
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

@Controller('v1/ops')
class OpsController {
  @Get('ping')
  @Roles(['operator'])
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PartnerController, FanController, OpsController] })
class LimitModule {}

@Module({ controllers: [FanController] })
class FanOnlyModule {}

/** identity GetAdminAuthz 대역 */
class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  calls = 0;
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    this.calls += 1;
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
}

const started: Awaited<ReturnType<typeof createService>>[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function boot(o: { env?: Record<string, string>; tenantRateLimit?: { redis: HotRedis; limit?: number } } = {}) {
  const identity = new FakeIdentity();
  const redis = new FakeRedis();
  identity.answers.set('acc-a1/s-a1', { valid: true, role: 'partner_admin', tenantId: 'tenant-a' });
  identity.answers.set('acc-a2/s-a2', { valid: true, role: 'partner_member', tenantId: 'tenant-a' });
  identity.answers.set('acc-n1/s-n1', { valid: true, role: 'partner_admin' });
  identity.answers.set('acc-v1/s-v1', { valid: true, role: 'viewer', tenantId: 'tenant-a' });
  identity.answers.set('acc-o1/s-o1', { valid: true, role: 'operator' });
  const svc = await createService({
    name: 'limit-svc',
    module: LimitModule,
    env: o.env ?? { PEAKET_ENV: 'ci' },
    clock: fakeClock(),
    adminAuthz: identity,
    tenantRateLimit: o.tenantRateLimit ?? { redis: redis as unknown as HotRedis },
  });
  started.push(svc);
  const inject = (url: string, headers: Record<string, string> = {}) => svc.http.inject({ method: 'GET' as const, url, headers });
  const metrics = async () => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload as unknown as string;
  return { svc, identity, redis, inject, metrics };
}

const partner = (account: string, session: string, extra: Record<string, string> = {}) => ({
  'x-user-id': account,
  'x-session-id': session,
  'x-user-aud': 'partner',
  ...extra,
});

describe('가드의 테넌트 판정 범위(D-T50 ⑦)', () => {
  test('D-T50 ⑦ partner_admin과 partner_member 모두 identity가 준 같은 테넌트 키를 올린다', async () => {
    const { inject, redis } = await boot();
    expect((await inject('/v1/limit/ping', partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    expect((await inject('/v1/limit/ping', partner('acc-a2', 's-a2'))).statusCode).toBe(200);
    expect(redis.calls.map((c) => c.keys[0])).toEqual(['rl:tenant:tenant-a', 'rl:tenant:tenant-a']);
  });

  test('D-T50 ⑦ 클라이언트가 보낸 x-tenant-id를 믿지 않고 identity가 준 테넌트로 센다', async () => {
    const { inject, redis } = await boot();
    const r = await inject('/v1/limit/ping', partner('acc-a1', 's-a1', { 'x-tenant-id': 'tenant-b' }));
    expect(r.statusCode).toBe(200);
    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0]?.keys).toEqual(['rl:tenant:tenant-a']);
  });

  test('D-T50 ⑦ 팬·관제 요청과 테넌트 없는 파트너 요청은 세지 않는다', async () => {
    const { inject, redis } = await boot();
    expect((await inject('/v1/fan/ping', { 'x-user-id': 'acc-fan', 'x-session-id': 's-fan', 'x-user-aud': 'fan' })).statusCode).toBe(200);
    expect((await inject('/v1/ops/ping', { 'x-user-id': 'acc-o1', 'x-session-id': 's-o1', 'x-user-aud': 'ops' })).statusCode).toBe(200);
    // 파트너 aud이지만 identity가 테넌트를 주지 않으면 처리기에 맡기고 세지 않는다(B10)
    expect((await inject('/v1/limit/ping', partner('acc-n1', 's-n1'))).statusCode).toBe(200);
    expect(redis.calls).toHaveLength(0);
  });

  test('D-T50 ⑦ 토큰 없음(401)·역할 밖(403)은 세지 않고 그 뒤 유효한 요청만 센다 [ASVS v5.0.0-2.4.1]', async () => {
    const { inject, redis, metrics } = await boot();
    for (let i = 0; i < 3; i++) expect((await inject('/v1/limit/ping')).statusCode).toBe(401);
    const forged = await inject('/v1/limit/ping', { 'x-user-id': 'acc-x', 'x-session-id': 's-x', 'x-user-aud': 'partner', 'x-user-role': 'partner_admin', 'x-tenant-id': 'tenant-a' });
    expect(forged.statusCode).toBe(401);
    expect((await inject('/v1/limit/ping', partner('acc-v1', 's-v1'))).statusCode).toBe(403);
    expect(redis.calls).toHaveLength(0);
    expect((await inject('/v1/limit/ping', partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    expect(redis.calls).toHaveLength(1);
    expect(sample(await metrics(), 'tenant_rate_limit_total', { service: 'limit-svc', result: 'allowed' })).toBe(1);
  });

  test('D-T50 ⑦ 601번째는 about:blank 429이고 Retry-After 정수·no-store·instance·traceId를 싣는다 [ASVS v5.0.0-2.4.1]', async () => {
    const { inject, redis } = await boot();
    redis.reply = [601, 25_000];
    const r = await inject('/v1/limit/ping', partner('acc-a1', 's-a1'));
    expect(r.statusCode).toBe(429);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['retry-after']).toBe('25');
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'about:blank', title: 'Too Many Requests', status: 429, instance: '/v1/limit/ping' });
    expect(body.traceId).toEqual(expect.any(String));
    expect(body.type).not.toContain('peaket.example/problems/');
    // 게이트웨이 429와 같은 about:blank 모양이고 이름 붙은 Problem이 아니다(M9)
    expect(body).not.toHaveProperty('detail');
  });

  test('D-T50 ⑦ 판정 실패는 200으로 통과하고 unavailable 지표만 오른다 [ASVS v5.0.0-16.5.2]', async () => {
    const { inject, redis, metrics } = await boot();
    redis.outcome = 'throw';
    expect((await inject('/v1/limit/ping', partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    const text = await metrics();
    expect(sample(text, 'tenant_rate_limit_total', { service: 'limit-svc', result: 'unavailable' })).toBe(1);
    expect(sample(text, 'tenant_rate_limit_total', { service: 'limit-svc', result: 'allowed' })).toBeUndefined();
    expect(sample(text, 'http_server_errors_total', { service: 'limit-svc', status_class: '5xx' })).toBeUndefined();
  });

  test('D-T50 ⑦ 지표 라벨은 service·result뿐이고 테넌트·계정 ID를 싣지 않는다', async () => {
    const { inject, redis, metrics } = await boot();
    await inject('/v1/limit/ping', partner('acc-a1', 's-a1'));
    redis.reply = [601, 25_000];
    await inject('/v1/limit/ping', partner('acc-a1', 's-a1'));
    const text = await metrics();
    expect(sample(text, 'tenant_rate_limit_total', { service: 'limit-svc', result: 'allowed' })).toBe(1);
    expect(sample(text, 'tenant_rate_limit_total', { service: 'limit-svc', result: 'limited' })).toBe(1);
    expect(text).not.toMatch(/tenant-a|acc-a1|s-a1/);
  });
});

describe('시작 규칙: local·ci 밖에서 파트너 처리기 + 가드 없음은 시작 실패(D-T50 ⑦)', () => {
  const KEY = Buffer.alloc(32, 5).toString('base64');
  const prod = { PEAKET_ENV: 'prod', PEAKET_LOG_PSEUDONYM_KEY: KEY };

  test('D-T50 ⑦ prod에서 파트너 역할 처리기가 있는데 tenantRateLimit이 없으면 시작이 실패한다', async () => {
    const identity = new FakeIdentity();
    await expect(
      createService({ name: 'no-guard', module: LimitModule, env: prod, clock: fakeClock(), adminAuthz: identity }),
    ).rejects.toThrow(/tenantRateLimit/);
  });

  test('D-T50 ⑦ local·ci는 tenantRateLimit 없이도 시작하고, 파트너 처리기가 없는 서비스는 prod에서도 시작한다', async () => {
    for (const env of ['local', 'ci']) {
      const svc = await createService({ name: `no-guard-${env}`, module: LimitModule, env: { PEAKET_ENV: env }, clock: fakeClock(), adminAuthz: new FakeIdentity() });
      expect(svc.name, env).toBe(`no-guard-${env}`);
      await svc.close();
    }
    const fanOnly = await createService({ name: 'fan-only', module: FanOnlyModule, env: prod, clock: fakeClock() });
    expect(fanOnly.name).toBe('fan-only');
    await fanOnly.close();
  });

  test('D-T50 ⑦ prod에서 tenantRateLimit을 넘기면 파트너 처리기가 있는 서비스가 시작한다', async () => {
    const svc = await createService({
      name: 'with-guard',
      module: LimitModule,
      env: prod,
      clock: fakeClock(),
      adminAuthz: new FakeIdentity(),
      tenantRateLimit: { redis: new FakeRedis() as unknown as HotRedis },
    });
    started.push(svc);
    expect(svc.name).toBe('with-guard');
  });
});
