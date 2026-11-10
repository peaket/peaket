// 경로별 본문 상한과 서비스의 요청 받기 시한(BUILD_ORDER HOT-150 코드 리뷰 M4, docs/features/payment.md §5 '웹훅 받기의 첫 구현').
import 'reflect-metadata';
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AcceptMultipart, BodyLimit, DEFAULT_BODY_LIMIT_BYTES, ProblemError, Roles, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

/** 칸막이 시험: 처리기 안에서 기다리게 하는 문 */
const gate = { current: { promise: Promise.resolve(), open: () => {} }, hits: 0 };
const SHARED = { name: 'big-body', limit: 1, retryAfterSeconds: 9 };

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

  @HttpCode(200)
  @Post('big')
  @Roles(['public'])
  @BodyLimit(DEFAULT_BODY_LIMIT_BYTES * 2, { bulkhead: SHARED })
  async big(@Body() body: unknown) {
    gate.hits++;
    await gate.current.promise;
    return { length: JSON.stringify(body).length };
  }

  @HttpCode(200)
  @Post('upload')
  @Roles(['public'])
  @AcceptMultipart({ maxBytes: 64, tooLarge: () => new ProblemError({ type: 'image-too-large', status: 413, title: '크다' }), bulkhead: SHARED })
  upload() {
    return { ok: true };
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

describe('@BodyLimit의 칸막이(ADR-0260 결정 11)', () => {
  test('HOT240_기본 상한보다 큰 상한은 칸막이와 함께 받고, 칸막이가 없으면 단 때 실패한다', async () => {
    const payload = JSON.stringify({ a: 'x'.repeat(DEFAULT_BODY_LIMIT_BYTES + 10) });
    expect((await post('/v1/limit/big', payload)).statusCode).toBe(200);
    expect((await post('/v1/limit/default', payload)).statusCode).toBe(413);
    expect(() => BodyLimit(DEFAULT_BODY_LIMIT_BYTES + 1)).toThrow(RangeError);
    expect(() => BodyLimit(DEFAULT_BODY_LIMIT_BYTES)).not.toThrow();
  });

  test('HOT240_같은 이름의 multipart 경로와 자리를 함께 써서 찼으면 본문을 읽기 전에 429와 Retry-After다', async () => {
    let open!: () => void;
    gate.current = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
    const first = post('/v1/limit/big', JSON.stringify({ a: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post('/v1/limit/big', JSON.stringify({ a: 2 }));
    expect([busy.statusCode, busy.headers['retry-after'], JSON.parse(busy.payload).type]).toEqual([429, '9', 'https://peaket.example/problems/server-busy']);
    const up = await svc.http.inject({ method: 'POST', url: '/v1/limit/upload', headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--' });
    expect(up.statusCode).toBe(429);
    gate.current.open();
    expect((await first).statusCode).toBe(200);
    // 응답이 끝나면 자리를 놓는다
    gate.current = { promise: Promise.resolve(), open: () => {} };
    expect((await post('/v1/limit/big', JSON.stringify({ a: 3 }))).statusCode).toBe(200);
  });
});

describe('칸막이 자리는 처리기가 끝날 때까지 쥔다(ADR-0260 결정 11)', () => {
  test('HOT240_손님이 연결을 끊어도 처리기가 끝나기 전에는 자리를 놓지 않는다', async () => {
    const { connect } = await import('node:net');
    await svc.http.listen({ port: 0, host: '127.0.0.1' });
    const port = (svc.http.server.address() as { port: number }).port;
    let open!: () => void;
    gate.current = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
    gate.hits = 0;
    // 실제 소켓으로 보내고 처리기에 닿은 뒤 끊는다
    const body = JSON.stringify({ a: 1 });
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(['POST /v1/limit/big HTTP/1.1', 'Host: x', 'Content-Type: application/json', `Content-Length: ${body.length}`, '', body].join('\r\n'));
    for (let i = 0; i < 100 && gate.hits === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(gate.hits).toBe(1);
    sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    // 처리 중이라 자리가 차 있다(자리를 놓았다면 둘째 요청이 처리기에 들어가 문 앞에서 기다린다)
    const second = post('/v1/limit/big', JSON.stringify({ a: 2 }));
    const busy = await Promise.race([second, new Promise<'들어감'>((r) => setTimeout(() => r('들어감'), 1_000))]);
    open();
    expect(busy === '들어감' ? '들어감' : busy.statusCode).toBe(429);
    await second;
    // 처리기가 끝나면 놓는다
    gate.current = { promise: Promise.resolve(), open: () => {} };
    for (let i = 0; i < 50; i++) {
      const r = await post('/v1/limit/big', JSON.stringify({ a: 3 }));
      if (r.statusCode === 200) return;
      await new Promise((x) => setTimeout(x, 20));
    }
    throw new Error('처리기가 끝난 뒤에도 자리를 놓지 않았다');
  });
});

describe('createService requestTimeoutMs', () => {
  test('HOT150_요청 받기 시한을 앱 포트 서버에 건다', () => {
    expect(svc.http.server.requestTimeout).toBe(5_000);
  });
});
