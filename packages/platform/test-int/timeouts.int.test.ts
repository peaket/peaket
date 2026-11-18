// 시간 초과 지표(docs/architecture.md §5 '요청별 상한'·'앱 연결 풀' 표와 '지표는' 줄, docs/observability.md §3, ADR-0070, BUILD_ORDER BAS-080).
// 실제 PostgreSQL 18과 Valkey 8.1로 본다: 풀 대기 초과(핫패스 100ms [가정]) → 429 server-busy·Retry-After 1초와 db_pool_wait_timeout_total{service},
// 문장 시간 초과(SQLSTATE 57014) → db_statement_timeout_total{role}, Redis 명령 마감 초과 → redis_command_timeout_total{cluster}.
// 지표 칸은 시험마다 다른 라벨(서비스·역할·클러스터 이름)로 갈라 다른 시험의 수와 섞이지 않게 한다.
import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DATABASE, PlatformMetrics, Roles, createDatabase, createHotRedis, createService, databaseModule, fakeClock, type Database } from '../src/index.js';
import { collector, sample } from '../test/fixture.js';
import { startValkey, type ValkeyContainer } from './containers.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pgc: PostgresContainer;
let valkey: ValkeyContainer;
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  [pgc, valkey] = await Promise.all([startPostgres(), startValkey()]);
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query("create role it_timeout login password 'it-timeout'");
  await admin.end();
}, 180_000);

afterAll(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
  pgc?.stop();
  valkey?.stop();
});

const timeoutCounts = async () => new PlatformMetrics('it-metrics').registry.metrics();

@Controller('v1/pool')
@Roles(['public'])
class PoolController {
  constructor(@Inject(DATABASE) private readonly d: Database) {}

  @Get('one')
  async one() {
    await this.d.db.execute(sql`select 1`);
    return { ok: true };
  }
}

test('풀대기한도를넘기면_429server-busy·Retry-After1이고_db_pool_wait_timeout_total이1늘며_문장시간초과지표는그대로다 [ASVS v5.0.0-15.1.3]', async () => {
  const d = createDatabase({ url: pgc.url, max: 1, profile: 'hot', applicationName: 'it-pool-svc' });
  closers.push(() => d.close());
  @Module({ imports: [databaseModule(d)], controllers: [PoolController] })
  class PoolModule {}
  const svc = await createService({ name: 'it-pool-svc', module: PoolModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, sigtermReadiness: false });
  closers.push(() => svc.close());
  // 첫 연결을 먼저 맺어 둔다(몰리는 러너에서 연결 맺기가 100ms를 넘는 것을 피한다, database.int.test.ts와 같은 까닭)
  for (let tries = 0; ; tries += 1) {
    try {
      await d.db.execute(sql`select 1`);
      break;
    } catch (e) {
      if (tries >= 20) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const holder = d.transaction(async () => {
    entered();
    await held;
  });
  await inside;
  const t0 = performance.now();
  const busy = await svc.http.inject({ method: 'GET', url: '/v1/pool/one' });
  const took = performance.now() - t0;
  release();
  await holder;
  expect(busy.statusCode).toBe(429);
  expect(busy.headers['retry-after']).toBe('1');
  expect(JSON.parse(busy.payload)).toMatchObject({ type: 'https://peaket.example/problems/server-busy', status: 429 });
  // 핫패스 풀 대기 100ms [가정] + 여유(요청 처리·로그)
  expect(took).toBeGreaterThanOrEqual(90);
  expect(took).toBeLessThan(600);
  const text = await (await svc.management.inject({ method: 'GET', url: '/metrics' })).payload;
  expect(sample(text, 'db_pool_wait_timeout_total', { service: 'it-pool-svc' })).toBe(1);
  expect(sample(text, 'db_statement_timeout_total', { role: 'postgres' }) ?? 0).toBe(0);
});

test('문장시간초과50ms에걸린pg_sleep은_실패하고_db_statement_timeout_total이역할라벨로1늘며_풀대기지표는그대로다 [ASVS v5.0.0-15.2.2]', async () => {
  const d = createDatabase({ url: pgc.urlFor('it_timeout', 'it-timeout'), max: 2, applicationName: 'it-stmt-svc' });
  closers.push(() => d.close());
  const err = await d.transaction((tx) => tx.execute(sql`select pg_sleep(1)`), { statementTimeoutMs: 50 }).then(
    () => undefined,
    (e: unknown) => e as { code?: string; cause?: { code?: string } },
  );
  expect(err?.cause?.code ?? err?.code).toBe('57014');
  // 시간 초과가 아닌 실패는 세지 않는다
  await expect(d.db.execute(sql`select 1/0`)).rejects.toBeDefined();
  const text = await timeoutCounts();
  expect(sample(text, 'db_statement_timeout_total', { role: 'it_timeout' })).toBe(1);
  expect(sample(text, 'db_pool_wait_timeout_total', { service: 'it-stmt-svc' })).toBeUndefined();
});

test('Valkey가CLIENT_PAUSE로멈춘동안의명령은_300ms안에실패하고_redis_command_timeout_total이클러스터라벨로1늘어난다 [ASVS v5.0.0-15.2.2]', async () => {
  const redis = await createHotRedis({ url: valkey.url, cluster: 'it-pause' });
  const admin = await createHotRedis({ url: valkey.url });
  closers.push(() => redis.close(), () => admin.close());
  await expect(redis.command(['SET', 'to:k', '1'], { key: 'to:k' })).resolves.toBe('OK');
  await admin.command(['CLIENT', 'PAUSE', '1000', 'ALL']);
  const t0 = performance.now();
  await expect(redis.command(['GET', 'to:k'], { key: 'to:k' })).rejects.toBeDefined();
  expect(performance.now() - t0).toBeLessThan(300);
  expect(sample(await timeoutCounts(), 'redis_command_timeout_total', { cluster: 'it-pause' })).toBe(1);
  // 멈춤이 풀리면 다시 답한다(다음 시험·닫기가 매달리지 않게)
  await new Promise((r) => setTimeout(r, 1_100));
  await expect(redis.command(['GET', 'to:k'], { key: 'to:k' })).resolves.toBe('1');
});
