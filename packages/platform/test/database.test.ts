// DB 설정의 단위 시험(컨테이너 없이). 실제 PostgreSQL 시험은 test-int/database.int.test.ts다.
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { Roles, createDatabase, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

describe('DB 설정', () => {
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
