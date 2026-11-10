// 본문 형식과 415(openspec 변경 add-service-structure-and-request-checks 결정 6, asvs/delivery.md 3.5.2, ADR-0065 결정 6).
import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AcceptMultipart, AcceptTextPlain, ProblemError, Roles, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

/** 칸막이 시험: 처리기 안에서 기다리게 하는 문 */
const heldGate = { current: { promise: Promise.resolve(), open: () => {} } };

@Controller('v1/ct')
class CtController {
  @HttpCode(200)
  @Post('json')
  @Roles(['public'])
  json(@Body() body: unknown) {
    return { body: body ?? null, type: typeof body };
  }

  @HttpCode(200)
  @Post('text')
  @Roles(['public'])
  @AcceptTextPlain()
  text(@Body() body: unknown) {
    return { body: body ?? null, type: typeof body };
  }

  @HttpCode(200)
  @Post('upload')
  @Roles(['public'])
  @AcceptMultipart({ maxBytes: 64, tooLarge: () => new ProblemError({ type: 'image-too-large', status: 413, title: '한 장에 10MB까지 올릴 수 있습니다' }) })
  upload(@Body() body: unknown) {
    return { isBuffer: Buffer.isBuffer(body), length: Buffer.isBuffer(body) ? body.length : -1 };
  }

  @HttpCode(200)
  @Post('held')
  @Roles(['public'])
  @AcceptMultipart({ maxBytes: 64, tooLarge: () => new ProblemError({ type: 'image-too-large', status: 413, title: '한 장에 10MB까지 올릴 수 있습니다' }), bulkhead: { name: 'shared', limit: 1, retryAfterSeconds: 7 } })
  async held() {
    await heldGate.current.promise;
    return { ok: true };
  }

  @HttpCode(200)
  @Post('held2')
  @Roles(['public'])
  @AcceptMultipart({ maxBytes: 64, tooLarge: () => new ProblemError({ type: 'image-too-large', status: 413, title: '한 장에 10MB까지 올릴 수 있습니다' }), bulkhead: { name: 'shared', limit: 1, retryAfterSeconds: 7 } })
  held2() {
    return { ok: true };
  }

  @Get('read')
  @Roles(['public'])
  read() {
    return { ok: true };
  }
}

@Module({ controllers: [CtController] })
class CtModule {}

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'ct-svc', module: CtModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream });
});
afterAll(async () => {
  await svc.close();
});

const post = (url: string, headers: Record<string, string>, payload: string) => svc.http.inject({ method: 'POST', url, headers, payload });

describe('본문 형식', () => {
  test('FND070_표시하지않은경로의_text_plain·폼·형식없는본문은_415다 [ASVS v5.0.0-3.5.2]', async () => {
    const cases: Record<string, string>[] = [
      { 'content-type': 'text/plain' },
      { 'content-type': 'text/plain; charset=utf-8' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=x' },
      {},
    ];
    for (const headers of cases) {
      const r = await post('/v1/ct/json', headers, '{"a":1}');
      expect({ headers, status: r.statusCode }).toEqual({ headers, status: 415 });
      expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
      const b = JSON.parse(r.payload) as Record<string, unknown>;
      expect({ type: b.type, title: b.title, status: b.status }).toEqual({ type: 'about:blank', title: 'Unsupported Media Type', status: 415 });
    }
  });

  test('FND070_JSON본문은_그대로받는다', async () => {
    const r = await post('/v1/ct/json', { 'content-type': 'application/json; charset=utf-8' }, '{"a":1}');
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ body: { a: 1 }, type: 'object' });
  });

  test('FND070_표시한경로는_text_plain본문을_JSON으로읽고_JSON도받는다', async () => {
    const t = await post('/v1/ct/text', { 'content-type': 'text/plain;charset=UTF-8' }, '{"preverifyToken":"t"}');
    expect(t.statusCode).toBe(200);
    expect(JSON.parse(t.payload)).toEqual({ body: { preverifyToken: 't' }, type: 'object' });
    const j = await post('/v1/ct/text', { 'content-type': 'application/json' }, '{"a":2}');
    expect(JSON.parse(j.payload)).toEqual({ body: { a: 2 }, type: 'object' });
  });

  test('FND070_text_plain본문도_깨진JSON과_원형오염키는_400이다', async () => {
    for (const payload of ['{"a":', '{"__proto__":{"x":1}}', '{"constructor":{"prototype":{"x":1}}}']) {
      const r = await post('/v1/ct/text', { 'content-type': 'text/plain' }, payload);
      expect({ payload, status: r.statusCode }).toEqual({ payload, status: 400 });
    }
  });

  test('FND070_본문없는요청은_형식검사를받지않는다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: '/v1/ct/read', headers: { 'content-type': 'text/plain' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('multipart 올리기 경로(ADR-0257)', () => {
  const mp = { 'content-type': 'multipart/form-data; boundary=x' };

  test('ADR0257_표시한경로는_multipart본문을_바이트그대로받는다(상한과 같은 길이까지)', async () => {
    const at = await post('/v1/ct/upload', mp, 'a'.repeat(64));
    expect(at.statusCode).toBe(200);
    expect(JSON.parse(at.payload)).toEqual({ isBuffer: true, length: 64 });
  });

  test('ADR0257_상한을_1바이트넘으면_이름붙은413이고_JSON경로의multipart는_그대로415다', async () => {
    const over = await post('/v1/ct/upload', mp, 'a'.repeat(65));
    expect(over.statusCode).toBe(413);
    expect(JSON.parse(over.payload)).toMatchObject({ type: 'https://peaket.example/problems/image-too-large', status: 413 });
    const json = await post('/v1/ct/json', mp, 'a');
    expect(json.statusCode).toBe(415);
  });

  test('ADR0257_길이머리가_상한보다크면_본문을읽지않고413이다', async () => {
    const r = await svc.http.inject({ method: 'POST', url: '/v1/ct/upload', headers: { ...mp, 'content-length': '1000' }, payload: 'a'.repeat(1000) });
    expect(r.statusCode).toBe(413);
  });
});

describe('multipart 칸막이(ADR-0257 결정 2)', () => {
  test('ADR0257_같은 이름의 칸막이를 쓰는 경로는 자리가 차면 본문을 읽지 않고 429 server-busy와 Retry-After이고 응답이 끝나면 자리를 놓는다', async () => {
    let open!: () => void;
    heldGate.current = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
    const mp = { 'content-type': 'multipart/form-data; boundary=x' };
    // inject는 then을 불러야 보낸다
    const first = post('/v1/ct/held', mp, 'a').then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post('/v1/ct/held2', mp, 'a');
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBe('7');
    expect(JSON.parse(busy.payload)).toMatchObject({ type: 'https://peaket.example/problems/server-busy', status: 429 });
    // 칸막이가 없는 multipart 경로는 막지 않는다
    expect((await post('/v1/ct/upload', mp, 'a')).statusCode).toBe(200);
    heldGate.current.open();
    expect((await first).statusCode).toBe(200);
    expect((await post('/v1/ct/held2', mp, 'a')).statusCode).toBe(200);
  });
});
