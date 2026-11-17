// 경로별 본문 상한과 서비스의 요청 받기 시한(BUILD_ORDER HOT-150 코드 리뷰 M4, docs/features/payment.md §5 '웹훅 받기의 첫 구현').
import 'reflect-metadata';
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AcceptMultipart, BodyLimit, Bulkhead, DEFAULT_BODY_LIMIT_BYTES, ProblemError, Roles, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';
import { RawClient, closedWithin, sleep, trackConnections, trickle } from './raw-http.js';

/** 칸막이 시험: 처리기 안에서 기다리게 하는 문 */
const gate = { current: { promise: Promise.resolve(), open: () => {} }, hits: 0 };
const SHARED = { name: 'big-body', limit: 1, retryAfterSeconds: 9 };
const PLAIN = { name: 'plain-bulkhead', limit: 1, retryAfterSeconds: 5 };

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

  @HttpCode(200)
  @Post('plain')
  @Roles(['public'])
  @Bulkhead(PLAIN)
  async plainBulkhead() {
    gate.hits++;
    await gate.current.promise;
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

describe('@Bulkhead(HTTP 백프레셔)', () => {
  test('BAT037_본문 상한이 없어도 같은 이름의 칸막이가 차면 429 server-busy와 Retry-After다', async () => {
    let open!: () => void;
    gate.current = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
    const first = post('/v1/limit/plain', '{}');
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post('/v1/limit/plain', '{}');
    expect([busy.statusCode, busy.headers['retry-after'], JSON.parse(busy.payload).type]).toEqual([429, '5', 'https://peaket.example/problems/server-busy']);
    open();
    expect((await first).statusCode).toBe(200);
    gate.current = { promise: Promise.resolve(), open: () => {} };
    expect((await post('/v1/limit/plain', '{}')).statusCode).toBe(200);
  });

  test('BAT037_칸막이 이름·한도·Retry-After가 틀리면 만들 때 RangeError다', () => {
    expect(() => Bulkhead({ name: '', limit: 1, retryAfterSeconds: 1 })).toThrow(RangeError);
    expect(() => Bulkhead({ name: 'x', limit: 0, retryAfterSeconds: 1 })).toThrow(RangeError);
    expect(() => Bulkhead({ name: 'x', limit: 1.5, retryAfterSeconds: 1 })).toThrow(RangeError);
    expect(() => Bulkhead({ name: 'x', limit: 1, retryAfterSeconds: -1 })).toThrow(RangeError);
    expect(() => Bulkhead({ name: 'x', limit: 1, retryAfterSeconds: 0 })).not.toThrow();
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

// ===================== W9-fix3 F4(HOT-190 '선언 길이가 본문 상한을 넘으면…', 시험 담당 w9f3-test 2026-11-17) =====================
// 정본: docs/api/guidelines.md §7 '본문을 다 읽기 전에 답하면 연결을 닫는다'(추천 적용 2026-11-17, W9-fix3). 본문을 다 읽기 전에 오류로 답하는 모든 길
// (본문 상한 413, 칸막이 429)은 Connection: close를 달고 응답을 다 보낸 뒤 연결을 닫는다. 정상 응답은 keep-alive 그대로다.
// 시험 문턱(계획 §7 [가정], 시험에만 쓴다): 서버 쪽 소켓 bytesRead ≤ 1MiB, 닫힘 2초 안. 보내는 중인 손님은 응답 대신 끊김을 볼 수 있어(정본이 받아들임)
// 흘려보내기 사례는 첫 덩어리 뒤 응답을 받은 다음 나머지를 보낸다.
const MiB = 1024 * 1024;
const BYTES_READ_MAX = MiB;
const CLOSE_WITHIN_MS = 2_000;
const DECLARED = 8 * MiB;

let tracker: ReturnType<typeof trackConnections> | undefined;
async function rawPort(): Promise<number> {
  if (!svc.http.server.listening) await svc.http.listen({ port: 0, host: '127.0.0.1' });
  tracker ??= trackConnections(svc.http.server);
  return (svc.http.server.address() as { port: number }).port;
}

/**
 * 요청 하나를 실제 소켓으로 보낸다. first(본문 첫 몫)를 보낸 뒤 응답을 기다리고, 그 뒤 rest만큼 흘려보낸다.
 * 서버 쪽이 2초 안에 닫혔는지와 그때(또는 2초 뒤)의 bytesRead를 돌려준다
 */
async function rawSend(o: { path: string; contentType: string; chunked?: boolean; first?: Buffer; rest?: number }) {
  const port = await rawPort();
  const started = Date.now();
  const c = await RawClient.open(port);
  const side = await tracker!.of(c.localPort);
  c.head('POST', o.path, { 'Content-Type': o.contentType, ...(o.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': DECLARED }) });
  if (o.first) c.write(o.chunked ? Buffer.concat([Buffer.from(`${o.first.length.toString(16)}\r\n`), o.first, Buffer.from('\r\n')]) : o.first);
  const response = await c.response(0, CLOSE_WITHIN_MS);
  if (o.rest) await trickle(c, { totalBytes: o.rest, chunkBytes: 64 * 1024, intervalMs: 5, chunked: o.chunked });
  const closed = await closedWithin(side, Math.max(0, CLOSE_WITHIN_MS - (Date.now() - started)));
  const bytesRead = side.bytesRead();
  c.destroy();
  return { response, closed, bytesRead };
}

/** 한도 1 칸막이(SHARED)를 처리기 안에서 붙잡는다. 찼는지 먼저 단언한다(장애 주입이 실제로 끼어들었는지) */
async function holdShared(): Promise<{ release(): Promise<void> }> {
  let open!: () => void;
  gate.current = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
  gate.hits = 0;
  const first = post('/v1/limit/big', JSON.stringify({ a: 1 }));
  for (let i = 0; i < 100 && gate.hits === 0; i++) await sleep(10);
  expect(gate.hits, '칸막이를 붙잡을 요청이 처리기에 닿지 않았다(시험 준비)').toBe(1);
  expect((await post('/v1/limit/big', JSON.stringify({ a: 2 }))).statusCode, '칸막이가 차 있어야 한다(시험 준비)').toBe(429);
  return {
    async release() {
      open();
      expect((await first).statusCode).toBe(200);
      gate.current = { promise: Promise.resolve(), open: () => {} };
    },
  };
}

describe('W9F3 F4 본문을 다 읽기 전의 오류 답은 연결을 닫는다', () => {
  test('W9F3 F4 칸막이가 찼을 때 429는 연결을 닫고 남은 본문을 읽지 않는다 [ASVS v5.0.0-15.2.2] [ASVS v5.0.0-2.4.1]', async () => {
    const hold = await holdShared();
    try {
      // ① 머리만(선언 8MiB): 본문 없이 바로 429, Connection: close, 서버가 닫는다
      const headOnly = await rawSend({ path: '/v1/limit/big', contentType: 'application/json' });
      expect(headOnly.response?.status, '① 머리만: 상태').toBe(429);
      expect(headOnly.response?.headers.connection?.toLowerCase(), '① 머리만: Connection').toBe('close');
      expect(JSON.parse(headOnly.response?.body ?? '{}').type).toBe('https://peaket.example/problems/server-busy');
      expect(headOnly.closed, '① 머리만: 서버가 2초 안에 닫지 않았다').toBe(true);
      expect(headOnly.bytesRead, '① 머리만: bytesRead').toBeLessThanOrEqual(BYTES_READ_MAX);
      // ② 선언 8MiB를 5ms마다 64KiB씩 흘려보낸다
      const declared = await rawSend({ path: '/v1/limit/big', contentType: 'application/json', first: Buffer.alloc(64 * 1024, 0x61), rest: DECLARED - 64 * 1024 });
      expect(declared.response?.status, '② 선언 길이 흘려보내기: 상태').toBe(429);
      expect(declared.closed, '② 선언 길이 흘려보내기: 서버가 2초 안에 닫지 않았다').toBe(true);
      expect(declared.bytesRead, '② 선언 길이 흘려보내기: bytesRead').toBeLessThanOrEqual(BYTES_READ_MAX);
      // ③ chunked로 같게
      const chunked = await rawSend({ path: '/v1/limit/big', contentType: 'application/json', chunked: true, first: Buffer.alloc(64 * 1024, 0x61), rest: DECLARED - 64 * 1024 });
      expect(chunked.response?.status, '③ chunked 흘려보내기: 상태').toBe(429);
      expect(chunked.closed, '③ chunked 흘려보내기: 서버가 2초 안에 닫지 않았다').toBe(true);
      expect(chunked.bytesRead, '③ chunked 흘려보내기: bytesRead').toBeLessThanOrEqual(BYTES_READ_MAX);
    } finally {
      await hold.release();
    }
  }, 20_000);

  test('W9F3 F4 본문 상한 413도 연결을 닫는다(회귀) [ASVS v5.0.0-5.2.1] [ASVS v5.0.0-15.2.2]', async () => {
    // 지금(inject)과 같은 이름 붙은 Problem이어야 한다
    const jsonTooLarge = JSON.parse((await post('/v1/limit/small', `{${'x'.repeat(64)}}`)).payload).type as string;
    const cases = [
      { what: 'multipart 선언 길이 넘침(머리만)', path: '/v1/limit/upload', contentType: 'multipart/form-data; boundary=x', type: 'https://peaket.example/problems/image-too-large' },
      { what: 'multipart chunked 넘침', path: '/v1/limit/upload', contentType: 'multipart/form-data; boundary=x', chunked: true, first: Buffer.alloc(1024, 0x61), rest: DECLARED, type: 'https://peaket.example/problems/image-too-large' },
      { what: 'JSON @BodyLimit 선언 길이(머리만)', path: '/v1/limit/small', contentType: 'application/json', type: jsonTooLarge },
      { what: 'JSON @BodyLimit chunked', path: '/v1/limit/small', contentType: 'application/json', chunked: true, first: Buffer.alloc(1024, 0x61), rest: DECLARED, type: jsonTooLarge },
    ];
    for (const c of cases) {
      const r = await rawSend(c);
      expect(r.response?.status, `${c.what}: 상태`).toBe(413);
      expect(JSON.parse(r.response?.body ?? '{}').type, `${c.what}: Problem`).toBe(c.type);
      expect(r.response?.headers.connection?.toLowerCase(), `${c.what}: Connection`).toBe('close');
      expect(r.closed, `${c.what}: 서버가 2초 안에 닫지 않았다`).toBe(true);
      expect(r.bytesRead, `${c.what}: bytesRead`).toBeLessThanOrEqual(BYTES_READ_MAX);
    }
  }, 30_000);

  test('W9F3 F4 정상 요청은 연결을 다시 쓴다 [ASVS v5.0.0-15.2.2]', async () => {
    const port = await rawPort();
    for (const path of ['/v1/limit/default', '/v1/limit/big']) {
      const c = await RawClient.open(port);
      const side = await tracker!.of(c.localPort);
      try {
        for (const [i, payload] of [JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })].entries()) {
          c.head('POST', path, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
          c.write(payload);
          const r = await c.response(i, CLOSE_WITHIN_MS);
          expect(r?.status, `${path} ${i + 1}번째`).toBe(200);
          expect(r?.headers.connection?.toLowerCase(), `${path} ${i + 1}번째: Connection`).not.toBe('close');
        }
        // 한 연결로 두 응답을 받았고 서버가 그 연결을 닫지 않았다
        expect(side.closed, `${path}: 정상 응답 뒤 서버가 연결을 닫았다`).toBe(false);
      } finally {
        c.destroy();
      }
    }
  });
});
