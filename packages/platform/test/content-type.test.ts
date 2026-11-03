// 본문 형식과 415(openspec 변경 add-service-structure-and-request-checks 결정 6, asvs/delivery.md 3.5.2, ADR-0065 결정 6).
import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AcceptTextPlain, Roles, createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

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
  test('ASVS_3_5_2_FND070_표시하지않은경로의_text_plain·폼·형식없는본문은_415다 [ASVS v5.0.0-3.5.2]', async () => {
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
