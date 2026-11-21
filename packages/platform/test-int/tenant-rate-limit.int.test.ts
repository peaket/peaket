// BAT-173 파트너 API 테넌트당 600회/분 공용 가드의 통합 시험(D-T50 ⑦, docs/api/guidelines.md §6, docs/data.md §3·§5).
// 실제 Valkey 8.1(Docker) 하나에 서비스 인스턴스 둘(같은 모듈·같은 Redis, 서로 다른 연결)을 세우고,
// 가짜 identity GetAdminAuthz가 같은 테넌트의 계정 둘(A1·A2)과 다른 테넌트(B)를 답하게 한다.
// 판정: 같은 테넌트 계정 둘이 합쳐 601번째가 429이고 600번째까지는 통과한다. 키는 rl:tenant:{tenantId} 하나, 60초 수명.
// Docker 잠금 lane2-BAT-173 안에서 Valkey만 띄운다(계획 §10·§11).
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Controller, Get, Module } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  Roles,
  createHotRedis,
  createService,
  fakeClock,
  tenantRateLimitKey,
  type AdminAuthz,
  type AdminAuthzPort,
  type HotRedis,
  type PlatformService,
  type Principal,
} from '../src/index.js';
import { startValkey, type ValkeyContainer } from './containers.js';

@Controller('v1/partner')
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
class PartnerModule {}

/** identity GetAdminAuthz 대역. 계정·세션마다 정한 답을 준다 */
class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>([
    ['acc-a1/s-a1', { valid: true, role: 'partner_admin', tenantId: 'tenant-a' }],
    ['acc-a2/s-a2', { valid: true, role: 'partner_member', tenantId: 'tenant-a' }],
    ['acc-b1/s-b1', { valid: true, role: 'partner_admin', tenantId: 'tenant-b' }],
    ['acc-v1/s-v1', { valid: true, role: 'viewer', tenantId: 'tenant-a' }],
    ['acc-o1/s-o1', { valid: true, role: 'operator' }],
  ]);
  calls = 0;
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    this.calls += 1;
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
}

const LOG_KEY = Buffer.alloc(32, 9).toString('base64');
const sink = new Writable({
  write(_chunk, _enc, cb) {
    cb();
  },
});
const services: PlatformService[] = [];
const connections: HotRedis[] = [];
let valkey: ValkeyContainer;
let inspector: HotRedis;
let identity: FakeIdentity;

/**
 * 셈 시험의 판정 마감(W12-dt50 ①). 이 파일의 셈 시험은 INCR 원자성·600/601 경계·두 인스턴스 합계·키 수명·배선을 보고,
 * 20ms 기본 마감의 열림은 단위 시험(test/tenant-rate-limit.test.ts)과 T8이 본다. 붐비는 러너에서 첫 판정이 20ms를 넘겨
 * 세지 않고 통과하면(정본의 열림) 정확한 수 단언이 흔들리므로 넉넉히 준다. 열림이 또 나면 expectNoOpen이 원인 이름으로 실패한다.
 */
const COUNT_DEADLINE_MS = 5_000;
/** 시험이 키를 읽고 바꾸는 검사용 연결의 명령 마감(W12-dt50 ⑤). 판정 대상이 아니라 시험 장치다 */
const INSPECT_DEADLINE_MS = 5_000;
const inspect = (args: string[]) => inspector.command(args, { deadlineMs: INSPECT_DEADLINE_MS });

beforeAll(async () => {
  valkey = await startValkey();
  inspector = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await inspector?.close();
  valkey?.stop();
});

beforeEach(async () => {
  await inspect(['FLUSHDB']);
  // 스크립트 캐시도 비워 모든 시험의 첫 판정이 NOSCRIPT → EVAL 길을 지나게 한다(W12-dt50 ④. 시험 차례·골라 돌리기와 상관없이 바탕이 같다)
  await inspect(['SCRIPT', 'FLUSH']);
  identity = new FakeIdentity();
});

afterEach(async () => {
  while (services.length) await services.pop()!.close();
  while (connections.length) await connections.pop()!.close();
});

async function boot(name: string, o: { limit?: number; timeoutMs?: number } = {}): Promise<PlatformService> {
  const redis = await createHotRedis({ url: valkey.url });
  connections.push(redis);
  const svc = await createService({
    name,
    module: PartnerModule,
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_PSEUDONYM_KEY: LOG_KEY },
    clock: fakeClock(),
    logDestination: sink,
    adminAuthz: identity,
    tenantRateLimit: { redis, ...(o.limit === undefined ? {} : { limit: o.limit }), timeoutMs: o.timeoutMs ?? COUNT_DEADLINE_MS },
  });
  services.push(svc);
  return svc;
}

/** 서비스 인스턴스 둘(같은 테넌트 카운터를 함께 올린다) */
async function bootPair(names: [string, string] = ['partner-int-1', 'partner-int-2']): Promise<[PlatformService, PlatformService]> {
  return [await boot(names[0]), await boot(names[1])];
}

const partner = (account: string, session: string, extra: Record<string, string> = {}) => ({
  'x-user-id': account,
  'x-session-id': session,
  'x-user-aud': 'partner',
  ...extra,
});
const fan = { 'x-user-id': 'acc-fan', 'x-session-id': 's-fan', 'x-user-aud': 'fan' };

const get = (svc: PlatformService, headers: Record<string, string> = {}) => svc.http.inject({ method: 'GET' as const, url: '/v1/partner/ping', headers });
const getFan = (svc: PlatformService) => svc.http.inject({ method: 'GET' as const, url: '/v1/fan/ping', headers: fan });

/** 200을 1번부터 n번까지 보낸다. 하나라도 다르면 그 번호와 함께 실패한다 */
async function expectAllowed(svc: PlatformService, headers: Record<string, string>, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) expect((await get(svc, headers)).statusCode, `${i}번째`).toBe(200);
}

const keyOf = async (tenant: string) => (await inspect(['GET', tenantRateLimitKey(tenant)])) as string | null;
const pttlOf = async (tenant: string) => Number(await inspect(['PTTL', tenantRateLimitKey(tenant)]));

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

const metricsOf = async (svc: PlatformService) => (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload as unknown as string;
const opensOf = async (svc: PlatformService) => sample(await metricsOf(svc), 'tenant_rate_limit_total', { service: svc.name, result: 'unavailable' });

/**
 * 그 인스턴스들에 판정 열림(마감·오류로 세지 않고 통과)이 한 건도 없었음을 본다(W12-dt50 ③).
 * 셈 시험은 모든 요청이 Redis 판정에 닿는다는 전제로 정확한 수를 단언하므로, 키 값·429를 단언하기 앞에 이 전제를 먼저 본다.
 * 열림이 나면 '599≠600' 대신 '열림 n건'으로 실패해 원인이 바로 보인다.
 */
async function expectNoOpen(...svcs: PlatformService[]): Promise<void> {
  for (const svc of svcs) expect(await opensOf(svc), `${svc.name} 판정 열림(unavailable) 건수`).toBeUndefined();
}

describe('D-T50 ⑦ 서비스 층 테넌트 한도(실제 Valkey, 서비스 두 인스턴스)', () => {
  test('D-T50 ⑦ 같은 테넌트 계정 둘이 합쳐 601번째에 429이고 600번째까지는 통과한다', async () => {
    const [one, two] = await bootPair();
    // 계정 A1 300건은 인스턴스 1, 계정 A2 300건은 인스턴스 2로 보낸다(계정별이 아니라 테넌트 합계임을 본다)
    await expectAllowed(one, partner('acc-a1', 's-a1'), 300);
    await expectAllowed(two, partner('acc-a2', 's-a2'), 300);
    await expectNoOpen(one, two);
    expect(await keyOf('tenant-a')).toBe('600');

    const limited = await get(one, partner('acc-a1', 's-a1'));
    await expectNoOpen(one, two);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(JSON.parse(limited.payload)).toMatchObject({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      instance: '/v1/partner/ping',
    });
    expect(JSON.parse(limited.payload).traceId).toEqual(expect.any(String));
    expect(await keyOf('tenant-a')).toBe('601');
  });

  test('D-T50 ⑦ 두 서비스 인스턴스가 같은 테넌트 카운터를 올린다', async () => {
    const [one, two] = await bootPair();
    await expectAllowed(one, partner('acc-a1', 's-a1'), 300);
    await expectNoOpen(one);
    expect(await keyOf('tenant-a')).toBe('300');
    // 두 번째 인스턴스가 이어서 센다(같은 키). 601번째는 두 번째 인스턴스가 429로 끝낸다
    for (let i = 301; i <= 600; i++) expect((await get(two, partner('acc-a2', 's-a2'))).statusCode, `${i}번째`).toBe(200);
    await expectNoOpen(one, two);
    expect(await keyOf('tenant-a')).toBe('600');
    const limited = await get(two, partner('acc-a2', 's-a2'));
    await expectNoOpen(one, two);
    expect(limited.statusCode).toBe(429);
    expect(await keyOf('tenant-a')).toBe('601');
    const pttl = await pttlOf('tenant-a');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);
  });

  test('D-T50 ⑦ 600번째는 통과하고 601번째만 429다(599·600·601 경계)', async () => {
    const one = await boot('partner-int');
    await expectAllowed(one, partner('acc-a1', 's-a1'), 599);
    await expectNoOpen(one);
    const r600 = await get(one, partner('acc-a1', 's-a1'));
    const r601 = await get(one, partner('acc-a1', 's-a1'));
    const r602 = await get(one, partner('acc-a1', 's-a1'));
    await expectNoOpen(one);
    expect(r600.statusCode, '600번째').toBe(200);
    expect(r601.statusCode, '601번째').toBe(429);
    expect(r602.statusCode, '602번째').toBe(429);
    expect(await keyOf('tenant-a')).toBe('602');
  });

  test('D-T50 ⑦ 다른 테넌트·팬·관제·스캐너 요청은 같은 카운터를 올리지 않는다 [ASVS v5.0.0-8.4.1]', async () => {
    const one = await boot('partner-int');
    await expectAllowed(one, partner('acc-a1', 's-a1'), 100);
    await expectAllowed(one, partner('acc-b1', 's-b1'), 100);
    // partner_member도 같은 테넌트 카운터를 올린다(M5)
    expect((await get(one, partner('acc-a2', 's-a2'))).statusCode).toBe(200);
    await expectNoOpen(one);
    expect(await keyOf('tenant-a')).toBe('101');
    expect(await keyOf('tenant-b')).toBe('100');

    // 팬 601건은 모두 통과하고 테넌트 키를 만들지 않는다
    for (let i = 1; i <= 601; i++) expect((await getFan(one)).statusCode, `팬 ${i}번째`).toBe(200);
    // 관제 신원과 스캐너 신원은 파트너 경로에서 401이고 세지 않는다
    expect((await get(one, { 'x-user-id': 'acc-o1', 'x-session-id': 's-o1', 'x-user-aud': 'ops' })).statusCode).toBe(401);
    expect((await get(one, { 'x-user-id': 'acc-s1', 'x-session-id': 's-s1', 'x-user-aud': 'scanner' })).statusCode).toBe(401);
    expect(await inspect(['KEYS', 'rl:tenant:*'])).toEqual(expect.arrayContaining(['rl:tenant:tenant-a', 'rl:tenant:tenant-b']));
    expect((await inspect(['KEYS', 'rl:tenant:*'])) as string[]).toHaveLength(2);

    // 테넌트 A가 막힌 뒤에도 B는 자기 키로 통과한다(M2)
    await inspect(['SET', tenantRateLimitKey('tenant-a'), '600']);
    await inspect(['PEXPIRE', tenantRateLimitKey('tenant-a'), '60000']);
    const a = await get(one, partner('acc-a1', 's-a1'));
    const b = await get(one, partner('acc-b1', 's-b1'));
    await expectNoOpen(one);
    expect(a.statusCode, 'A 막힘').toBe(429);
    expect(b.statusCode, 'B 통과').toBe(200);
  });

  test('D-T50 ⑦ 401·403 요청은 세지 않고 유효한 요청만 센다', async () => {
    const one = await boot('partner-int');
    for (let i = 0; i < 601; i++) expect((await one.http.inject({ method: 'GET' as const, url: '/v1/partner/ping' })).statusCode, `무토큰 ${i + 1}`).toBe(401);
    for (let i = 0; i < 601; i++) expect((await get(one, partner('acc-v1', 's-v1'))).statusCode, `역할 밖 ${i + 1}`).toBe(403);
    expect(await keyOf('tenant-a')).toBeNull();
    expect((await get(one, partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    await expectNoOpen(one);
    expect(await keyOf('tenant-a')).toBe('1');
  });

  test('D-T50 ⑦ 클라이언트가 보낸 x-tenant-id를 믿지 않고 identity가 준 테넌트로 센다 [ASVS v5.0.0-8.4.1]', async () => {
    const one = await boot('partner-int');
    expect((await get(one, partner('acc-a1', 's-a1', { 'x-tenant-id': 'tenant-b' }))).statusCode).toBe(200);
    expect((await get(one, partner('acc-a2', 's-a2', { 'x-tenant-id': 'tenant-b' }))).statusCode).toBe(200);
    await expectNoOpen(one);
    expect(await keyOf('tenant-a')).toBe('2');
    expect(await keyOf('tenant-b')).toBeNull();
  });

  test('D-T50 ⑦ Redis가 끊겨도 통과하고 돌아오면 다시 센다 [ASVS v5.0.0-16.5.2]', async () => {
    // 열림이 주제라 판정 마감을 짧게 따로 준다(W12-dt50 ②). 멈춘 Valkey는 답하지 않으므로 어떤 유한한 마감에서도 열림이 반드시 나고,
    // 250ms [가정]는 복구 뒤 600건+429 단언이 판정 p99(이 PC 2ms 안팎)의 100배 넘는 여유를 갖게 하는 값이다
    const one = await boot('partner-int', { timeoutMs: 250 });
    valkey.pause();
    try {
      const started = performance.now();
      const r = await get(one, partner('acc-a1', 's-a1'));
      expect(r.statusCode).toBe(200);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(sample(await metricsOf(one), 'tenant_rate_limit_total', { service: 'partner-int', result: 'unavailable' })).toBe(1);
      expect(sample(await metricsOf(one), 'http_server_errors_total', { service: 'partner-int', status_class: '5xx' })).toBeUndefined();
    } finally {
      valkey.resume();
    }
    // 멈춘 동안 보낸 명령이 풀리며 남았을 수 있으므로 키를 비우고 다시 센다
    for (let i = 0; i < 50; i++) {
      try {
        await inspector.command(['PING']);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await inspect(['DEL', tenantRateLimitKey('tenant-a')]);
    await expectAllowed(one, partner('acc-a1', 's-a1'), 600);
    const limited = await get(one, partner('acc-a1', 's-a1'));
    // 복구 뒤에는 열림이 없어야 정확한 수를 단언할 수 있다. 멈춘 동안의 1건 그대로다(W12-dt50 ③)
    expect(await opensOf(one), '복구 뒤 판정 열림(unavailable) 건수').toBe(1);
    expect(limited.statusCode).toBe(429);
  }, 30_000);

  test('D-T50 ⑦ 카운터 키는 60초 수명을 갖고 창이 끝나면 다시 센다', async () => {
    const one = await boot('partner-int');
    await expectAllowed(one, partner('acc-a1', 's-a1'), 600);
    await expectNoOpen(one);
    const pttl = await pttlOf('tenant-a');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(60_000);
    expect(Number(await inspect(['TTL', tenantRateLimitKey('tenant-a')]))).not.toBe(-1);
    // 창을 1초로 줄여 기다리면 키가 사라지고 다시 600회를 받는다(M12: 앱 시계가 아니라 Redis 수명이 창이다)
    await inspect(['PEXPIRE', tenantRateLimitKey('tenant-a'), '1']);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await keyOf('tenant-a')).toBeNull();
    expect((await get(one, partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    await expectNoOpen(one);
    expect(await keyOf('tenant-a')).toBe('1');
    expect(await pttlOf('tenant-a')).toBeGreaterThan(0);
  });

  test('D-T50 ⑦ 동시 601건에서도 600건만 통과한다 [ASVS v5.0.0-2.4.1]', async () => {
    // 이 시험은 INCR 원자성(600 초과 통과 없음)을 본다. 판정 마감 20ms의 열림 동작은 T7·T8이 따로 본다:
    // 한 프로세스·한 연결에 601건을 한꺼번에 넣으면 클라이언트의 100ms 명령 마감을 넘겨 일부가 열림으로 통과한다(의도한 열림).
    // 그래서 여기서는 파드 여럿처럼 연결 여럿(8개)에 나눠 보내 모든 요청이 Redis 판정에 닿게 하고, 판정 마감도 늘린다.
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => boot(`partner-int-${i + 1}`, { timeoutMs: COUNT_DEADLINE_MS })));
    // 첫 EVALSHA가 NOSCRIPT로 실패하지 않게 스크립트를 한 번 올린다(그 요청도 한도에 센다)
    expect((await get(many[0]!, partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    const all = await Promise.all(Array.from({ length: 601 }, (_, i) => get(many[i % many.length]!, partner('acc-a1', 's-a1'))));
    const statuses = all.map((r) => r.statusCode);
    await expectNoOpen(...many);
    expect(statuses.filter((s) => s === 200)).toHaveLength(599);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    expect(Number(await keyOf('tenant-a'))).toBeGreaterThanOrEqual(601);
  }, 30_000);

  test('D-T50 ⑦ 429는 게이트웨이와 같은 about:blank 모양이고 이름 붙은 Problem이 아니다', async () => {
    const one = await boot('partner-int', { limit: 1 });
    expect((await get(one, partner('acc-a1', 's-a1'))).statusCode).toBe(200);
    const r = await get(one, partner('acc-a1', 's-a1'));
    await expectNoOpen(one);
    expect(r.statusCode).toBe(429);
    const body = JSON.parse(r.payload) as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'about:blank', title: 'Too Many Requests', status: 429 });
    expect(body.instance).toBe('/v1/partner/ping');
    expect(body.traceId).toEqual(expect.any(String));
    expect(body).not.toHaveProperty('detail');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
