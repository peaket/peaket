// 준비 프로브는 표시만 본다(D-T19 ①, docs/architecture.md §5 '프로브 규칙', ADR-0070 결정 2)와
// SIGTERM을 받으면 서비스의 종료 처리기보다 먼저 준비 상태를 내린다(docs/devops.md §6.4 ①, BUILD_ORDER BAS-080, ADR-0303 결정 1).
// 실제 Valkey를 멈추는 D-T19 ②는 test-int/probes.int.test.ts가 본다.
import 'reflect-metadata';
import { createServer, type Server, type Socket } from 'node:net';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import { DATABASE, Roles, createDatabase, createService, databaseModule, fakeClock, type Database, type PlatformService } from '../src/index.js';
import { collector } from './fixture.js';

/** 받기만 하고 답하지 않는 TCP 서버(멈춘 PostgreSQL·Redis 대역). 붙은 수와 받은 바이트를 센다 */
async function silentServer() {
  const sockets = new Set<Socket>();
  const seen = { connections: 0, bytes: 0 };
  const server: Server = createServer((s) => {
    seen.connections += 1;
    sockets.add(s);
    s.on('data', (d) => (seen.bytes += d.length));
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const REDIS = Symbol('test.redis');
/** 부르면 세고 답하지 않는 Redis 대역 */
const redisCalls = { n: 0 };
const hangingRedis = { command: () => (redisCalls.n++, new Promise(() => {})) };

@Controller('v1/deps')
@Roles(['public'])
class DepsController {
  constructor(
    @Inject(DATABASE) private readonly d: Database,
    @Inject(REDIS) private readonly r: typeof hangingRedis,
  ) {}

  @Get('db')
  async db() {
    await this.d.pool.query('select 1');
    return { ok: true };
  }

  @Get('redis')
  async redis() {
    await this.r.command();
    return { ok: true };
  }
}

@Module({})
class EmptyModule {}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('D-T19 ① 준비 프로브는 공유 의존성을 부르지 않는다', () => {
  test('D-T19 ①_답하지않는PostgreSQL·Redis대역을붙인서비스의_ready는20번모두200이고50ms안이며_대역에닿지않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const pgStub = await silentServer();
    cleanups.push(pgStub.close);
    const database = createDatabase({ url: `postgres://svc:pw@127.0.0.1:${pgStub.port}/x`, applicationName: 'deps-svc', connectionTimeoutMillis: 5_000 });
    cleanups.push(() => database.close().catch(() => {}));
    @Module({ imports: [databaseModule(database)], controllers: [DepsController], providers: [{ provide: REDIS, useValue: hangingRedis }] })
    class DepsModule {}
    redisCalls.n = 0;
    const svc = await createService({ name: 'deps-svc', module: DepsModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, sigtermReadiness: false });
    cleanups.push(() => svc.close());
    // 첫 요청은 경로 준비(JIT)로 느릴 수 있어 한 번 데운다. 시험을 함께 돌리는 러너의 흔들림을 넘기려고 가운데 값을 50ms [가정]로,
    // 가장 느린 것을 1,000ms로 본다(대역을 불렀다면 연결 시간 초과 5초를 기다린다)
    await svc.management.inject({ method: 'GET', url: '/ready' });
    const took: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      const r = await svc.management.inject({ method: 'GET', url: '/ready' });
      took.push(performance.now() - t0);
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.payload)).toEqual({ status: 'ready' });
    }
    took.sort((x, y) => x - y);
    expect(took[10]!).toBeLessThan(50);
    expect(took[19]!).toBeLessThan(1_000);
    expect((await svc.management.inject({ method: 'GET', url: '/livez' })).statusCode).toBe(200);
    expect(pgStub.seen).toEqual({ connections: 0, bytes: 0 });
    expect(redisCalls.n).toBe(0);
    // 대역은 진짜로 매달린다(그 의존성을 쓰는 경로는 /ready와 따로 붙는다)
    void svc.http.inject({ method: 'GET', url: '/v1/deps/redis' });
    await new Promise((r) => setTimeout(r, 20));
    expect(redisCalls.n).toBe(1);
  });
});

describe('BAS-080 SIGTERM 준비 내림(docs/devops.md §6.4 ①)', () => {
  // vitest 작업자는 SIGTERM을 받지 않는다. process.emit으로 처리기만 부른다(진짜 신호는 test-int/shutdown.int.test.ts)
  const listeners: (() => void)[] = [];
  afterEach(() => {
    for (const l of listeners.splice(0)) process.removeListener('SIGTERM', l);
  });

  async function boot(o: { sigtermReadiness?: boolean } = {}) {
    // 서비스의 종료 처리기 대역을 서비스 뼈대보다 먼저 단다: 그래도 준비 내림이 먼저여야 한다
    const atHandler: { ready?: boolean; pending?: string[] } = {};
    let svc!: PlatformService;
    const handler = () => {
      atHandler.ready = svc.readiness.isReady();
      atHandler.pending = svc.readiness.pending();
    };
    process.on('SIGTERM', handler);
    listeners.push(handler);
    svc = await createService({ name: 'term-svc', module: EmptyModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, ...o });
    cleanups.push(() => svc.close());
    return { svc, atHandler };
  }

  test('SIGTERM을받으면_서비스처리기가불리기전에_ready가503·shutting-down이고_livez는200이다', async () => {
    const { svc, atHandler } = await boot();
    expect((await svc.management.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    process.emit('SIGTERM');
    expect(atHandler).toEqual({ ready: false, pending: ['shutting-down'] });
    const r = await svc.management.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toEqual({ status: 'shutting-down', pending: ['shutting-down'] });
    expect((await svc.management.inject({ method: 'GET', url: '/livez' })).statusCode).toBe(200);
  });

  test('sigtermReadiness_false면_SIGTERM뒤에도_ready가200이다', async () => {
    const { svc, atHandler } = await boot({ sigtermReadiness: false });
    process.emit('SIGTERM');
    expect(atHandler).toEqual({ ready: true, pending: [] });
    expect((await svc.management.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });

  test('close한서비스는_SIGTERM처리기를떼어_다음SIGTERM에표시를건드리지않는다', async () => {
    const before = process.listenerCount('SIGTERM');
    const { svc } = await boot();
    expect(process.listenerCount('SIGTERM')).toBe(before + 2);
    await svc.close();
    cleanups.pop();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  });
});
