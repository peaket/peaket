// 요청 검사(openspec 변경 add-service-structure-and-request-checks 결정 2~5, BUILD_ORDER FND-070).
// 일반 경로의 Zod 파이프와 핫패스의 Fastify 경로 스키마가 같은 표본을 같게 거르는지 본다(V-T41의 표본 묶음, 기술 검토 낮음-001).
import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { MerchOrderItems } from '@peaket/contracts/openapi/model';
import { CreateQueueEntryBody, CreateQueueEntryParams } from '@peaket/contracts/openapi/queue';
import {
  GetEventSeatmapSnapshotParams,
  GetEventSeatmapSnapshotQueryParams,
  CreateEventHoldBody,
  CreateEventHoldHeader,
  CreateEventHoldParams,
} from '@peaket/contracts/openapi/seats';
import {
  AcceptTextPlain,
  ContractBody,
  ContractHeaders,
  ContractParams,
  ContractQuery,
  ContractRouteSchema,
  IdempotencyRequest,
  Idempotent,
  PurchaseSigned,
  Roles,
  contractRouteSchema,
  createService,
  fakeClock,
} from '../src/index.js';
import { SIGN, collector, signPurchaseHeaders, testPurchaseSessions } from './fixture.js';

const ListQuery = z.object({ ids: z.array(z.string()).max(3).optional(), flag: z.boolean().optional(), n: z.number().optional() });
const StrictQuery = z.object({ a: z.string().optional() }).strict();
const FanBody = z.object({ seat: z.string() });
// 정수 머리 바꾸기 표본. 계약의 정수 머리였던 X-Purchase-Seq는 FND-100부터 구매 요청 인증 훅만 본다
const PageHeaders = z.object({ 'X-Page-Size': z.int().min(1) });

@Controller('v1/t')
class PipeController {
  @Get('events/:eventId/seatmap/snapshot')
  @Roles(['public'])
  snapshot(
    @ContractParams(GetEventSeatmapSnapshotParams) params: unknown,
    @ContractQuery(GetEventSeatmapSnapshotQueryParams) query: unknown,
  ) {
    return { params, query };
  }

  // 멱등 키는 머리 스키마가 아니라 멱등 모듈이 본다(FND-080 결정 1). 그래서 홀드 표본 경로는 팬 신원과 @Idempotent를 단다
  @HttpCode(200)
  @Post('events/:eventId/holds')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_HOLD' })
  @PurchaseSigned()
  hold(
    @ContractParams(CreateEventHoldParams) _params: unknown,
    @ContractHeaders(CreateEventHoldHeader) headers: Record<string, unknown>,
    @ContractBody(CreateEventHoldBody) body: unknown,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    return { headers, key: idem.key, body };
  }

  @Get('page')
  @Roles(['public'])
  page(@ContractHeaders(PageHeaders) headers: Record<string, unknown>) {
    return { headers };
  }

  @HttpCode(200)
  @Post('queues/:eventId/entries')
  @Roles(['public'])
  @AcceptTextPlain()
  entry(@ContractParams(CreateQueueEntryParams) _p: unknown, @ContractBody(CreateQueueEntryBody) body: unknown) {
    return { body };
  }

  @Get('list')
  @Roles(['public'])
  list(@ContractQuery(ListQuery) query: unknown) {
    return { query };
  }

  @Get('strict')
  @Roles(['public'])
  strict(@ContractQuery(StrictQuery) query: unknown) {
    return { query };
  }

  @HttpCode(200)
  @Post('fan-holds')
  @Roles(['fan'])
  fanHold(@ContractBody(FanBody) body: unknown) {
    return { body };
  }

  @HttpCode(200)
  @Post('merch')
  @Roles(['public'])
  merch(@ContractBody(MerchOrderItems) body: unknown) {
    return { body };
  }
}

@Controller('v1/t/rs')
class RouteSchemaController {
  @HttpCode(200)
  @Post('events/:eventId/holds')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_HOLD' })
  @PurchaseSigned()
  @ContractRouteSchema({ params: CreateEventHoldParams, headers: CreateEventHoldHeader, body: CreateEventHoldBody })
  hold(@Body() body: unknown) {
    return { body };
  }

  @HttpCode(200)
  @Post('queues/:eventId/entries')
  @Roles(['public'])
  @AcceptTextPlain()
  @ContractRouteSchema({ params: CreateQueueEntryParams, body: CreateQueueEntryBody })
  entry() {
    return { ok: true };
  }

  @Get('list')
  @Roles(['public'])
  @ContractRouteSchema({ query: ListQuery })
  list() {
    return { ok: true };
  }

  @HttpCode(200)
  @Post('merch')
  @Roles(['public'])
  @ContractRouteSchema({ body: MerchOrderItems })
  merch() {
    return { ok: true };
  }

  @Get('strict')
  @Roles(['public'])
  @ContractRouteSchema({ query: StrictQuery })
  strict() {
    return { ok: true };
  }

  @HttpCode(200)
  @Post('fan-holds')
  @Roles(['fan'])
  @ContractRouteSchema({ body: FanBody })
  fanHold() {
    return { ok: true };
  }

  @Get('resp')
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 200: z.object({ a: z.string() }) } })
  resp() {
    return { a: 'x', secret: 'y' };
  }
}

@Module({ controllers: [PipeController, RouteSchemaController] })
class ChecksModule {}

let svc: Awaited<ReturnType<typeof createService>>;
const KEY = '0190f3a1-7c2e-4a00-8000-000000000001';
const holdHeaders = { 'x-user-id': 'acc-1', 'x-session-id': 's-1', 'x-user-aud': 'fan', 'content-type': 'application/json', 'idempotency-key': KEY, 'x-purchase-seq': 'next', 'x-purchase-mac': SIGN };

beforeAll(async () => {
  svc = await createService({ name: 'checks-svc', module: ChecksModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, purchaseSessions: testPurchaseSessions() });
});
afterAll(async () => {
  await svc.close();
});

// 홀드 경로는 구매 세션 요청 서명을 요구한다(FND-100). x-purchase-mac이 SIGN이면 요청마다 새 번호로 서명한다
const call = (o: { method: string; url: string; headers?: Record<string, string>; payload?: string }) =>
  svc.http.inject({ ...o, headers: signPurchaseHeaders(o.method, o.url, o.headers ?? {}, o.payload ?? '') } as never);
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const without = (b: Record<string, unknown>) => {
  const { traceId: _t, instance: _i, ...rest } = b;
  return rest;
};
const BAD_REQUEST = { type: 'about:blank', title: 'Bad Request', status: 400 };

describe('문자열 값 바꾸기(Zod 파이프)', () => {
  test('FND070_정수쿼리와_정수머리를_숫자로바꾸고_머리이름은계약대로받는다', async () => {
    const r = await call({ method: 'GET', url: '/v1/t/events/e1/seatmap/snapshot?section=3' });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ params: { eventId: 'e1' }, query: { section: 3 } });
    const h = await call({ method: 'GET', url: '/v1/t/page', headers: { 'x-page-size': '5' } });
    expect(h.statusCode).toBe(200);
    expect(json(h)).toEqual({ headers: { 'X-Page-Size': 5 } });
    const hold = await call({ method: 'POST', url: '/v1/t/events/e1/holds', headers: holdHeaders, payload: '{"seatIds":["A-1"]}' });
    expect(hold.statusCode).toBe(200);
    expect(json(hold)).toMatchObject({ key: KEY, headers: {} });
  });

  test('FND070_쉼표로이은배열과_불리언을_바꾼다', async () => {
    const r = await call({ method: 'GET', url: '/v1/t/list?ids=a,b&flag=true&n=-1.5e2' });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ query: { ids: ['a', 'b'], flag: true, n: -150 } });
  });

  test('ASVS_15_3_7_FND070_같은이름이겹친쿼리는_형과관계없이400이다 [ASVS v5.0.0-15.3.7]', async () => {
    for (const url of ['/v1/t/events/e1/seatmap/snapshot?section=1&section=2', '/v1/t/list?ids=a&ids=b']) {
      const r = await call({ method: 'GET', url });
      expect(r.statusCode).toBe(400);
      expect(without(json(r))).toEqual(BAD_REQUEST);
    }
  });

  test('FND070_형식이맞지않으면_Problem400이고_값을되비추지않는다', async () => {
    for (const url of ['/v1/t/events/e1/seatmap/snapshot?section=x', '/v1/t/events/e1/seatmap/snapshot?section=70000', '/v1/t/list?flag=yes', '/v1/t/list?n=0x10']) {
      const r = await call({ method: 'GET', url });
      expect(r.statusCode).toBe(400);
      const b = json(r);
      expect(Object.keys(b).sort()).toEqual(['instance', 'status', 'title', 'traceId', 'type']);
      expect(without(b)).toEqual(BAD_REQUEST);
      expect(r.payload).not.toMatch(/0x10|yes|70000/);
    }
    const noKey = await call({ method: 'POST', url: '/v1/t/events/e1/holds', headers: { ...holdHeaders, 'idempotency-key': '' }, payload: '{}' });
    expect(noKey.statusCode).toBe(400);
  });
});

/** 같은 표본을 두 길로 보내 결과를 견준다 */
async function bothWays(pathA: string, pathB: string, samples: { name: string; headers: Record<string, string>; payload: string; expect: number }[]) {
  for (const s of samples) {
    const a = await call({ method: 'POST', url: pathA, headers: s.headers, payload: s.payload });
    const b = await call({ method: 'POST', url: pathB, headers: s.headers, payload: s.payload });
    expect({ name: s.name, pipe: a.statusCode, route: b.statusCode }).toEqual({ name: s.name, pipe: s.expect, route: s.expect });
    if (s.expect >= 400) {
      expect({ name: s.name, body: without(json(a)) }).toEqual({ name: s.name, body: without(json(b)) });
    }
  }
}

describe('두 길의 표본 일치(V-T41 표본 묶음)', () => {
  test('[ASVS v5.0.0-15.3.3] FND070_좌석홀드표본을_Zod파이프와경로스키마가_같게거른다', async () => {
    const seats11 = JSON.stringify({ seatIds: Array.from({ length: 11 }, (_, i) => `A-${i}`) });
    await bothWays('/v1/t/events/e1/holds', '/v1/t/rs/events/e1/holds', [
      { name: '직접 선택', headers: holdHeaders, payload: '{"seatIds":["A-1"]}', expect: 200 },
      { name: '자동 배정(기본값)', headers: holdHeaders, payload: '{"auto":{"firstTierId":"t1","count":2}}', expect: 200 },
      // 핫패스 요청 본문은 계약에서 닫혀 있다(BAS-040, FND-070이 넘긴 것): 두 길 모두 정의 밖 칸을 400으로 거절한다
      { name: '모르는 칸(닫은 본문)', headers: holdHeaders, payload: '{"seatIds":["A-1"],"zzz":1}', expect: 400 },
      { name: '모르는 칸(닫은 안쪽 객체)', headers: holdHeaders, payload: '{"auto":{"firstTierId":"t1","count":2,"zzz":1}}', expect: 400 },
      { name: '배열 자리에 문자열', headers: holdHeaders, payload: '{"seatIds":"A-1"}', expect: 400 },
      { name: '배열 상한 초과', headers: holdHeaders, payload: seats11, expect: 400 },
      { name: '닫은 객체의 모르는 칸', headers: holdHeaders, payload: '{"behavior":{"v":1,"windowMs":10,"extra":1}}', expect: 400 },
      { name: '정수 칸에 문자열', headers: holdHeaders, payload: '{"behavior":{"v":1,"windowMs":"10"}}', expect: 400 },
      { name: '깨진 JSON', headers: holdHeaders, payload: '{"seatIds":', expect: 400 },
      { name: '멱등 키 없음', headers: { ...holdHeaders, 'idempotency-key': '' }, payload: '{}', expect: 400 },
      { name: '멱등 키가 UUID 아님', headers: { ...holdHeaders, 'idempotency-key': 'k-1' }, payload: '{}', expect: 400 },
      // 일련번호 형식은 FND-100부터 머리 스키마가 아니라 구매 요청 인증 훅이 본다(두 길 모두 401, purchase-auth.test.ts)
      { name: '일련번호 글자', headers: { ...holdHeaders, 'x-purchase-seq': 'abc' }, payload: '{}', expect: 401 },
      { name: '일련번호 0', headers: { ...holdHeaders, 'x-purchase-seq': '0' }, payload: '{}', expect: 401 },
      // 코드 리뷰 2026-11-01: Ajv strict: false가 strictNumbers까지 꺼 경로 스키마가 무한대를 받았다
      { name: '무한대 숫자', headers: holdHeaders, payload: '{"behavior":{"v":1,"windowMs":10,"pointerEntropy":1e400}}', expect: 400 },
    ]);
  });

  test('FND070_대기열진입표본을_text_plain과JSON으로_두길이같게거른다', async () => {
    const tp = { 'content-type': 'text/plain' };
    const js = { 'content-type': 'application/json' };
    await bothWays('/v1/t/queues/e1/entries', '/v1/t/rs/queues/e1/entries', [
      { name: 'text/plain 정상', headers: tp, payload: '{"preverifyToken":"t"}', expect: 200 },
      { name: 'JSON 정상', headers: js, payload: '{"preverifyToken":"t","entryRequestId":"0190f3a1-7c2e-4a00-8000-000000000002"}', expect: 200 },
      { name: '형이 틀림', headers: tp, payload: '{"preverifyToken":1}', expect: 400 },
      { name: 'UUID 아님', headers: tp, payload: '{"preverifyToken":"t","entryRequestId":"x"}', expect: 400 },
      { name: '필수 칸 없음', headers: tp, payload: '{}', expect: 400 },
      { name: '깨진 JSON', headers: tp, payload: '{"preverifyToken"', expect: 400 },
      { name: '폼 본문', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'preverifyToken=t', expect: 415 },
      // 코드 리뷰 2026-11-01: 형식별(content) 본문 스키마는 맞는 형식이 없으면 검사를 건너뛰어 본문 없는 POST가 200이었다
      { name: '본문 없음', headers: {}, payload: '', expect: 400 },
    ]);
  });

  test('FND070_생성스키마의검사규칙을_두길모두지킨다', async () => {
    const item = { productId: '0190f3a1-7c2e-7a00-8000-000000000001', quantity: 1 };
    const opts = (n: number, keyLen = 2) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i).padStart(keyLen, 'k'), 'v']));
    const js = { 'content-type': 'application/json' };
    await bothWays('/v1/t/merch', '/v1/t/rs/merch', [
      { name: '정상', headers: js, payload: JSON.stringify([item]), expect: 200 },
      { name: '중복 항목', headers: js, payload: JSON.stringify([item, { ...item }]), expect: 400 },
      { name: '키 순서만 다른 중복', headers: js, payload: JSON.stringify([{ ...item, options: { a: '1', b: '2' } }, { ...item, options: { b: '2', a: '1' } }]), expect: 400 },
      { name: '칸 수 10', headers: js, payload: JSON.stringify([{ ...item, options: opts(10) }]), expect: 200 },
      { name: '칸 수 11', headers: js, payload: JSON.stringify([{ ...item, options: opts(11) }]), expect: 400 },
      { name: '칸 이름 31자', headers: js, payload: JSON.stringify([{ ...item, options: opts(1, 31) }]), expect: 400 },
      // 코드 리뷰 2026-11-01: 칸 이름 길이를 UTF-16 단위로 세어 Zod·Ajv(코드 포인트)와 달랐다. 이모지 16자 = UTF-16 32
      { name: '칸 이름 이모지 16자', headers: js, payload: JSON.stringify([{ ...item, options: { ['😀'.repeat(16)]: 'v' } }]), expect: 200 },
      { name: '칸 이름 이모지 31자', headers: js, payload: JSON.stringify([{ ...item, options: { ['😀'.repeat(31)]: 'v' } }]), expect: 400 },
    ]);
  });

  test('FND070_경로스키마도_쿼리를바꾸고_겹친쿼리를거절한다', async () => {
    const ok = await call({ method: 'GET', url: '/v1/t/rs/list?ids=a,b&flag=true&n=2' });
    expect(ok.statusCode).toBe(200);
    for (const url of ['/v1/t/rs/list?ids=a&ids=b', '/v1/t/rs/list?flag=yes', '/v1/t/rs/list?ids=a,b,c,d']) {
      const r = await call({ method: 'GET', url });
      expect(r.statusCode).toBe(400);
      expect(without(json(r))).toEqual(BAD_REQUEST);
    }
  });

  test('FND070_무한대쿼리와_닫은쿼리의모르는키를_두길이같게거른다', async () => {
    for (const url of ['/v1/t/list?n=1e400', '/v1/t/rs/list?n=1e400', '/v1/t/strict?zzz=1', '/v1/t/rs/strict?zzz=1']) {
      const r = await call({ method: 'GET', url });
      expect({ url, status: r.statusCode }).toEqual({ url, status: 400 });
    }
    for (const url of ['/v1/t/strict?a=x', '/v1/t/rs/strict?a=x']) expect((await call({ method: 'GET', url })).statusCode).toBe(200);
  });

  test('FND070_신원없는요청은_본문이틀려도_두길모두401이다', async () => {
    // 코드 리뷰 2026-11-01: 경로 스키마 검사가 인증 가드보다 먼저 돌아 익명 요청이 400을 받았다(검사 규칙을 떠볼 수 있다)
    for (const url of ['/v1/t/fan-holds', '/v1/t/rs/fan-holds']) {
      const r = await call({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{"seat":1}' });
      expect({ url, status: r.statusCode }).toEqual({ url, status: 401 });
    }
    const fan = { 'content-type': 'application/json', 'x-user-id': 'a', 'x-session-id': 's', 'x-user-aud': 'fan' };
    for (const url of ['/v1/t/fan-holds', '/v1/t/rs/fan-holds']) {
      expect((await call({ method: 'POST', url, headers: fan, payload: '{"seat":1}' })).statusCode).toBe(400);
      expect((await call({ method: 'POST', url, headers: fan, payload: '{"seat":"A-1"}' })).statusCode).toBe(200);
    }
  });

  test('FND070_Nest밖에서붙인경로의스키마는_Fastify기본대로바로거절한다', async () => {
    // 다시 본 코드 리뷰 2026-11-01: 검사 결과를 붙여 두기만 하는 설정(attachValidation)이 모든 경로에 걸려, 인증 가드를 지나지 않는
    // 경로(서비스가 http에 바로 붙인 경로)는 검사 실패가 그대로 통과했다. Fastify 별칭 query도 놓쳤다
    const own = await createService({ name: 'raw-svc', module: ChecksModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, purchaseSessions: testPurchaseSessions() });
    try {
      const sc = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
      own.http.get('/raw-qs', { schema: { querystring: sc } }, async (req) => ({ q: req.query }));
      own.http.get('/raw-alias', { schema: { query: sc } as never }, async (req) => ({ q: req.query }));
      // 세 번째 리뷰 2026-11-01: 계약 스키마를 Fastify에 바로 붙인 경로에 써도 검사를 미루지 않는다(미루기 표시는 Nest 장식자만 단다)
      own.http.post('/raw-contract', { schema: contractRouteSchema({ body: FanBody }) }, async (req) => ({ b: req.body }));
      for (const url of ['/raw-qs?n=abc', '/raw-qs', '/raw-alias?n=abc']) {
        const r = await own.http.inject({ method: 'GET', url });
        expect({ url, status: r.statusCode }).toEqual({ url, status: 400 });
      }
      expect(JSON.parse((await own.http.inject({ method: 'GET', url: '/raw-qs?n=7' })).payload)).toEqual({ q: { n: 7 } });
      const raw = await own.http.inject({ method: 'POST', url: '/raw-contract', headers: { 'content-type': 'application/json' }, payload: '{"seat":1}' });
      expect(raw.statusCode).toBe(400);
    } finally {
      await own.close();
    }
  });

  test('FND070_두길이받은값이같다_기본값을채운다', async () => {
    for (const url of ['/v1/t/events/e1/holds', '/v1/t/rs/events/e1/holds']) {
      const a = await call({ method: 'POST', url, headers: holdHeaders, payload: '{"auto":{"firstTierId":"t1","count":2}}' });
      expect({ url, auto: (json(a).body as Record<string, unknown>).auto }).toEqual({ url, auto: { firstTierId: 't1', count: 2, wheelchair: false, allowSplit: false } });
    }
  });

  test('FND070_경로스키마의응답은_스키마에없는칸을내보내지않는다', async () => {
    const r = await call({ method: 'GET', url: '/v1/t/rs/resp' });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ a: 'x' });
  });
});
