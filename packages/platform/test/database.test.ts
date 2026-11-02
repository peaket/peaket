// DB 설정의 단위 시험(컨테이너 없이). 실제 PostgreSQL 시험은 test-int/database.int.test.ts다.
import 'reflect-metadata';
import net from 'node:net';
import { Controller, Get, Module } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { ProblemError, Roles, createDatabase, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

describe('DB 설정', () => {
  test('FND070_새연결을맺는데핫패스대기한도를넘겨도_기다리지않고429_server_busy다 [ASVS v5.0.0-13.1.2]', async () => {
    // BSL-040 v0 시험에서 찾음: 풀에 쉬는 연결이 없어 새 연결을 맺는 동안 한도(핫패스 100ms)를 넘기면 pg-pool이
    // 'Connection terminated due to connection timeout'을 내는데, 풀 대기 초과('timeout exceeded when trying to connect')만 429로 바꿔 500이 났다
    const held: net.Socket[] = [];
    const server = net.createServer((sock) => void held.push(sock)); // 받기만 하고 답하지 않는 PostgreSQL 자리
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const { port } = server.address() as net.AddressInfo;
    const d = createDatabase({ url: `postgres://nobody:x@127.0.0.1:${port}/none`, profile: 'hot' });
    try {
      const t0 = performance.now();
      const err = await d.transaction(async () => 1).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProblemError);
      const problem = err as ProblemError;
      expect({ slug: problem.slug, status: problem.status, retry: problem.retryAfterSeconds }).toEqual({ slug: 'server-busy', status: 429, retry: 1 });
      expect(performance.now() - t0).toBeLessThan(2_000);
    } finally {
      await d.close();
      for (const sock of held) sock.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  test('FND070_트랜잭션선택지가틀리면_던지지않고_거절된Promise를돌려준다', async () => {
    // 코드 리뷰 2026-11-01: 바로 던져 .catch()로 이은 호출이 오류를 못 잡았다
    const d = createDatabase({ url: 'postgres://nobody:x@127.0.0.1:1/none' });
    try {
      let p: Promise<unknown> | undefined;
      expect(() => {
        p = d.transaction(async () => 1, { statementTimeoutMs: 0 });
      }).not.toThrow();
      await expect(p).rejects.toBeInstanceOf(RangeError);
      await expect(d.transaction(async () => 1, { tenantId: '' })).rejects.toBeInstanceOf(RangeError);
    } finally {
      await d.close();
    }
  });

  test('ASVS_16_2_5_FND070_쿼리글에_치환패턴이있어도_매개변수값이로그에다시들어가지않는다 [ASVS v5.0.0-16.2.5]', async () => {
    // 코드 리뷰 2026-11-01: String.replace의 '$&'가 원래 메시지(params 포함)를 스택에 되살렸다
    @Controller('v1/q')
    @Roles(['public'])
    class Q {
      @Get('fail')
      fail() {
        throw new DrizzleQueryError("select '$&' || $1", ['secret-param@example.com'], Object.assign(new Error('boom'), { code: '22P02' }));
      }
    }
    @Module({ controllers: [Q] })
    class M {}
    const logs = collector();
    const svc = await createService({ name: 'q-svc', module: M, env: { PEAKET_ENV: 'ci', PEAKET_DEBUG_ERRORS: 'true', PEAKET_LOG_SAMPLE_ONE_IN: '1' }, clock: fakeClock(), logDestination: logs.stream });
    try {
      const r = await svc.http.inject({ method: 'GET', url: '/v1/q/fail' });
      expect(r.statusCode).toBe(500);
      expect(r.payload).not.toContain('secret-param');
      expect(logs.raw.join('')).not.toContain('secret-param');
      const line = logs.lines.find((l) => l.msg === 'request')!;
      expect((line.err as Record<string, string>).message).toBe("Failed query: select '$&' || $1 (22P02)");
    } finally {
      await svc.close();
    }
  });
});
