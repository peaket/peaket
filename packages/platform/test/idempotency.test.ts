// 멱등 키 검사·원시 본문·요청 지문(openspec 변경 add-idempotency-and-outbox 결정 1~5, BUILD_ORDER FND-080, docs/api/guidelines.md §4).
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Body, Controller, HttpCode, Module, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { CreateEventHoldBody, CreateEventHoldHeader } from '@peaket/contracts/openapi/seats';
import {
  AcceptTextPlain,
  ContractBody,
  ContractHeaders,
  ContractRouteSchema,
  IdempotencyRequest,
  Idempotent,
  PROBLEM_TYPE_BASE,
  PurchaseSigned,
  Roles,
  contractRouteSchema,
  createService,
  fakeClock,
  idempotencyKeyInvalid,
  idempotencyKeyReused,
  idempotencyRequestInProgress,
  parseIdempotencyKey,
  rawBodyOf,
  requestFingerprint,
} from '../src/index.js';
import { SIGN, collector, signPurchaseHeaders, testPurchaseSessions } from './fixture.js';

const KEY = '0190f3a1-7c2e-4a00-8000-000000000001';
const FAN = { 'x-user-id': 'acc-1', 'x-session-id': 's-1', 'x-user-aud': 'fan' };
const Note = z.object({ title: z.string() }).strict();

const idemView = (r: IdempotencyRequest) => ({ ...r, requestHash: Buffer.from(r.requestHash).toString('hex') });

@Controller('v1/i')
class IdemController {
  @HttpCode(200)
  @Post('pipe/holds')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_HOLD' })
  @PurchaseSigned()
  pipe(
    @ContractHeaders(CreateEventHoldHeader) headers: Record<string, unknown>,
    @ContractBody(CreateEventHoldBody) _body: unknown,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    return { headers, idem: idemView(idem) };
  }

  @HttpCode(200)
  @Post('rs/holds')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_HOLD' })
  @PurchaseSigned()
  @ContractRouteSchema({ headers: CreateEventHoldHeader, body: CreateEventHoldBody })
  route(@IdempotencyRequest() idem: IdempotencyRequest) {
    return { idem: idemView(idem) };
  }

  @HttpCode(200)
  @Post('notes')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_NOTE' })
  note(@ContractBody(Note) body: unknown, @IdempotencyRequest() idem: IdempotencyRequest) {
    return { body, idem: idemView(idem) };
  }

  @HttpCode(200)
  @Post('raw')
  @Roles(['public'])
  raw(@Body() body: unknown, @Req() req: FastifyRequest) {
    return { body: body ?? null, raw: rawBodyOf(req).toString('base64') };
  }

  @HttpCode(200)
  @Post('raw-text')
  @Roles(['public'])
  @AcceptTextPlain()
  rawText(@Body() body: unknown, @Req() req: FastifyRequest) {
    return { body, raw: rawBodyOf(req).toString('base64') };
  }
}

@Module({ controllers: [IdemController] })
class IdemModule {}

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'idem-svc', module: IdemModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, purchaseSessions: testPurchaseSessions() });
});
afterAll(async () => {
  await svc.close();
});

// 홀드 경로는 구매 세션 요청 서명을 요구한다(FND-100). x-purchase-mac이 SIGN이면 요청마다 새 번호로 서명한다
const call = (o: { method: string; url: string; headers?: Record<string, string>; payload?: string }) =>
  svc.http.inject({ ...o, headers: signPurchaseHeaders(o.method, o.url, o.headers ?? {}, o.payload ?? '') } as never);
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const holdHeaders = { ...FAN, 'content-type': 'application/json', 'idempotency-key': KEY, 'x-purchase-seq': 'next', 'x-purchase-mac': SIGN };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('키 형식(결정 2)', () => {
  test('FND080_따옴표없는UUIDv4만받고_소문자로맞춘다', () => {
    expect(parseIdempotencyKey(KEY)).toBe(KEY);
    expect(parseIdempotencyKey(KEY.toUpperCase())).toBe(KEY);
    for (const bad of [undefined, '', `"${KEY}"`, '0190f3a1-7c2e-7a00-8000-000000000001', '0190f3a1-7c2e-4a00-c000-000000000001', `${KEY}, ${KEY}`, [KEY, KEY], ` ${KEY}`, 'k-1']) {
      expect({ bad, v: parseIdempotencyKey(bad as never) }).toEqual({ bad, v: undefined });
    }
  });

  test('FND080_Problem셋의_type과상태와_다시시도시간', () => {
    expect(idempotencyKeyInvalid()).toMatchObject({ slug: 'idempotency-key-invalid', status: 400 });
    expect(idempotencyKeyReused()).toMatchObject({ slug: 'idempotency-key-reused', status: 422 });
    const p = idempotencyRequestInProgress();
    expect(p).toMatchObject({ slug: 'idempotency-request-in-progress', status: 409, normalBranch: true });
    expect(p.retryAfterSeconds).toBe(1);
  });
});

describe('요청 지문(결정 3)', () => {
  test('FND080_지문은_메서드와받은경로쿼리와본문바이트의SHA256이다', () => {
    const body = Buffer.from('{"a":1}');
    expect(Buffer.from(requestFingerprint('POST', '/v1/x?a=1', body)).toString('hex')).toBe(sha('POST\n/v1/x?a=1\n{"a":1}'));
    expect(Buffer.from(requestFingerprint('POST', '/v1/x?a=2', body)).toString('hex')).not.toBe(sha('POST\n/v1/x?a=1\n{"a":1}'));
    expect(Buffer.from(requestFingerprint('POST', '/v1/x', undefined)).toString('hex')).toBe(sha('POST\n/v1/x\n'));
  });
});

describe('검사 순서(결정 1)', () => {
  const paths = ['/v1/i/pipe/holds', '/v1/i/rs/holds'];

  test('FND080_익명요청은_키가없어도401이먼저다', async () => {
    for (const url of paths) {
      const { 'x-user-id': _u, 'x-session-id': _s, 'x-user-aud': _a, ...anon } = holdHeaders;
      const r = await call({ method: 'POST', url, headers: { ...anon, 'idempotency-key': '' }, payload: '{"seatIds":1}' });
      expect({ url, status: r.statusCode }).toEqual({ url, status: 401 });
    }
  });

  test('FND080_키가없거나틀리면_본문이틀려도_두길모두idempotency_key_invalid다', async () => {
    for (const url of paths) {
      for (const key of ['', 'k-1', `"${KEY}"`, '0190f3a1-7c2e-7a00-8000-000000000001', `${KEY}, ${KEY}`]) {
        const r = await call({ method: 'POST', url, headers: { ...holdHeaders, 'idempotency-key': key, 'x-purchase-seq': 'x' }, payload: '{"seatIds":1}' });
        expect({ url, key, status: r.statusCode, type: json(r).type }).toEqual({ url, key, status: 400, type: `${PROBLEM_TYPE_BASE}idempotency-key-invalid` });
      }
      const { 'idempotency-key': _k, ...noKey } = holdHeaders;
      const r = await call({ method: 'POST', url, headers: noKey, payload: '{}' });
      expect({ url, type: json(r).type }).toEqual({ url, type: `${PROBLEM_TYPE_BASE}idempotency-key-invalid` });
    }
  });

  test('FND080_키가맞고모양이틀리면_about_blank_400이다', async () => {
    for (const url of paths) {
      for (const [headers, payload] of [
        [holdHeaders, '{"seatIds":1}'],
        // 일련번호 0은 FND-100부터 머리 스키마가 아니라 구매 요청 인증 훅이 401로 막는다(purchase-auth.test.ts). 본문 모양 표본으로 바꿨다
        [holdHeaders, '{"seatIds":"A-1"}'],
      ] as const) {
        const r = await call({ method: 'POST', url, headers, payload });
        expect({ url, status: r.statusCode, type: json(r).type }).toEqual({ url, status: 400, type: 'about:blank' });
      }
    }
  });

  test('FND080_리뷰_경로스키마함수는_Fastify에바로붙이는경로를위해_멱등키칸을남긴다', () => {
    // 코드 리뷰 2026-11-01: 키를 늘 빼면 가드를 지나지 않는 경로는 키 없는 요청을 조용히 받았다. 빼는 것은 Nest 장식자(@ContractRouteSchema)뿐이다
    const s = contractRouteSchema({ headers: CreateEventHoldHeader }) as { headers: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(s.headers.properties)).toContain('idempotency-key');
    expect(s.headers.required).toEqual(expect.arrayContaining(['idempotency-key', 'x-purchase-seq']));
  });

  test('FND080_멱등요청값은_계정과작업과소문자키와지문이다', async () => {
    const payload = '{ "seatIds" : ["A-1"] }';
    for (const url of paths) {
      const r = await call({ method: 'POST', url: `${url}?via=t`, headers: { ...holdHeaders, 'idempotency-key': KEY.toUpperCase() }, payload });
      expect(r.statusCode).toBe(200);
      const b = json(r) as { idem: Record<string, unknown>; headers?: Record<string, unknown> };
      expect(b.idem).toEqual({ accountRef: 'acc-1', operation: 'CREATE_HOLD', key: KEY, requestHash: sha(`POST\n${url}?via=t\n${payload}`) });
      if (b.headers) {
        // 두 서명 머리도 FND-100부터 구매 요청 인증 훅만 본다(머리 스키마에 남는 칸이 없다)
        expect(b.headers).toEqual({});
      }
    }
  });
});

describe('원시 본문(결정 4)', () => {
  test('FND080_JSON본문은_해석값과함께_해석전바이트를남긴다', async () => {
    const payload = '{ "a" :  1 }';
    const r = await call({ method: 'POST', url: '/v1/i/raw', headers: { 'content-type': 'application/json' }, payload });
    expect(json(r)).toEqual({ body: { a: 1 }, raw: Buffer.from(payload).toString('base64') });
  });

  test('FND080_text_plain경로도_바이트를남기고_본문없는요청은빈바이트다', async () => {
    const payload = '{"preverifyToken":"한글"}';
    const t = await call({ method: 'POST', url: '/v1/i/raw-text', headers: { 'content-type': 'text/plain' }, payload });
    expect(json(t)).toEqual({ body: { preverifyToken: '한글' }, raw: Buffer.from(payload).toString('base64') });
    const e = await call({ method: 'POST', url: '/v1/i/raw' });
    expect(json(e)).toEqual({ body: null, raw: '' });
  });

  test('FND080_원형오염키는_바이트해석기에서도거절한다', async () => {
    const r = await call({ method: 'POST', url: '/v1/i/raw', headers: { 'content-type': 'application/json' }, payload: '{"__proto__":{"x":1}}' });
    expect(r.statusCode).toBe(400);
  });
});

describe('시작 확인(결정 5)', () => {
  test('FND080_리뷰_계약이멱등키를요구하는데_Idempotent를빠뜨린처리기는_두길모두시작실패다', async () => {
    // 코드 리뷰 2026-11-01: 머리 스키마에서 키를 빼므로, 장식자를 빠뜨리면 키 없는 요청이 통과해 다시 보낸 요청을 두 번 처리했다
    @Controller('v1/f')
    class Forgot {
      @Post('pipe')
      @Roles(['fan'])
      pipe(@ContractHeaders(CreateEventHoldHeader) _h: unknown) {
        return {};
      }

      @Post('rs')
      @Roles(['fan'])
      @ContractRouteSchema({ headers: CreateEventHoldHeader })
      rs() {
        return {};
      }
    }
    @Module({ controllers: [Forgot] })
    class M {}
    const err = await createService({ name: 'forgot-svc', module: M, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/Forgot\.pipe/);
    expect(String(err)).toMatch(/Forgot\.rs/);
  });

  test('FND080_공개역할을허용한처리기의멱등장식자는_시작실패다', async () => {
    @Controller('v1/p')
    class PublicIdem {
      @Post('x')
      @Roles(['public', 'fan'])
      @Idempotent({ operation: 'X' })
      x() {
        return {};
      }
    }
    @Module({ controllers: [PublicIdem] })
    class M {}
    await expect(createService({ name: 'bad-svc', module: M, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream })).rejects.toThrow(/PublicIdem\.x/);
  });
});
