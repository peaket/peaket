// 경로별 본문 상한과 서비스의 요청 받기 시한(BUILD_ORDER HOT-150 코드 리뷰 M4, docs/features/payment.md §5 '웹훅 받기의 첫 구현').
import 'reflect-metadata';
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BodyLimit, Roles, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

@Controller('v1/limit')
class LimitController {
  @HttpCode(200)
  @Post('small')
  @Roles(['public'])
  @BodyLimit(32)
  small(@Body() body: unknown) {
    return { body: body ?? null };
  }

  @HttpCode(200)
  @Post('default')
  @Roles(['public'])
  plain(@Body() body: unknown) {
    return { body: body ?? null };
  }
}

@Module({ controllers: [LimitController] })
class LimitModule {}

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'limit-svc', module: LimitModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, requestTimeoutMs: 5_000 });
});
afterAll(async () => {
  await svc.close();
});

const post = (url: string, payload: string) => svc.http.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });

describe('@BodyLimit', () => {
  test('HOT150_상한을 넘은 본문은 JSON으로 읽기 전에 413이다(해석기가 400을 내지 않는다)', async () => {
    expect((await post('/v1/limit/small', `{${'x'.repeat(32)}`)).statusCode).toBe(413);
  });

  test('HOT150_상한과 같은 본문은 받는다', async () => {
    const payload = JSON.stringify({ a: 'x'.repeat(24) });
    expect(Buffer.byteLength(payload)).toBe(32);
    expect((await post('/v1/limit/small', payload)).statusCode).toBe(200);
  });

  test('HOT150_표시하지 않은 경로는 그대로다', async () => {
    expect((await post('/v1/limit/default', JSON.stringify({ a: 'x'.repeat(100) }))).statusCode).toBe(200);
  });
});

describe('createService requestTimeoutMs', () => {
  test('HOT150_요청 받기 시한을 앱 포트 서버에 건다', () => {
    expect(svc.http.server.requestTimeout).toBe(5_000);
  });
});
