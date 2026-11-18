// D-T19 ② 정상 판에서 실제 Valkey를 멈춘다(docs/devops.md D-T19 ②, docs/architecture.md §5 '프로브 규칙', ADR-0070 결정 2, BUILD_ORDER BAS-080).
// 준비·생존 프로브는 그대로 200이고, Valkey를 쓰는 경로는 매달리지 않고 1,000ms [가정] 안에 5xx Problem으로 답하며, 다시 띄우면 다시 붙어 200이다.
// 다시 띄울 때 같은 포트를 쓰려고 이 파일에서 컨테이너를 고정 포트로 띄운다(docker stop·start, 끝나면 rm -f -v).
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Roles, createHotRedis, createService, fakeClock, type HotRedis, type PlatformService } from '../src/index.js';
import { collector } from '../test/fixture.js';
import { VALKEY_IMAGE } from './containers.js';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const REDIS = Symbol('it.redis');

@Controller('v1/cache')
@Roles(['public'])
class CacheController {
  constructor(@Inject(REDIS) private readonly redis: HotRedis) {}

  @Get('value')
  async value() {
    await this.redis.command(['SET', 'probe:k', '1'], { key: 'probe:k' });
    return { value: await this.redis.command(['GET', 'probe:k'], { key: 'probe:k' }) };
  }
}

let id = '';
let redis: HotRedis | undefined;
let svc: PlatformService | undefined;

beforeAll(async () => {
  const port = await freePort();
  id = docker(['run', '-d', '-p', `127.0.0.1:${port}:6379`, VALKEY_IMAGE]);
  const url = `redis://127.0.0.1:${port}`;
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      redis = await createHotRedis({ url, startupTimeoutMs: 2_000 });
      break;
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  @Module({ controllers: [CacheController], providers: [{ provide: REDIS, useValue: redis }] })
  class CacheModule {}
  svc = await createService({ name: 'probe-svc', module: CacheModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, sigtermReadiness: false });
}, 120_000);

afterAll(async () => {
  await svc?.close();
  await redis?.close().catch(() => {});
  if (id) docker(['rm', '-f', '-v', id]);
});

test('D-T19 ②_Valkey를멈춰도_ready·livez는200그대로이고_그경로는1000ms안에5xxProblem이며_다시띄우면다시붙어200이다 [ASVS v5.0.0-16.5.2]', { timeout: 120_000 }, async () => {
  const s = svc!;
  const probe = async (url: string) => (await s.management.inject({ method: 'GET', url })).statusCode;
  expect((await s.http.inject({ method: 'GET', url: '/v1/cache/value' })).statusCode).toBe(200);

  docker(['stop', '-t', '0', id]);
  for (let i = 0; i < 10; i += 1) {
    expect(await probe('/ready')).toBe(200);
    expect(await probe('/livez')).toBe(200);
    const t0 = performance.now();
    const r = await s.http.inject({ method: 'GET', url: '/v1/cache/value' });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    await new Promise((res) => setTimeout(res, 100));
  }
  expect(await probe('/ready')).toBe(200);

  docker(['start', id]);
  const end = Date.now() + 60_000;
  for (;;) {
    const r = await s.http.inject({ method: 'GET', url: '/v1/cache/value' });
    if (r.statusCode === 200) break;
    if (Date.now() > end) throw new Error(`다시 붙지 못했다: ${r.statusCode}`);
    await new Promise((res) => setTimeout(res, 250));
  }
  expect(await probe('/ready')).toBe(200);
});
