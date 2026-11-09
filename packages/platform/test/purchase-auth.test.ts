// 구매 요청 인증 훅(ADR-0050 결정 8, docs/frontend.md §5.3, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 6~9).
// 시험 벡터는 구현과 따로 파이썬 표준 라이브러리로 계산했다(HKDF 결과는 OpenSSL kdf로 다시 확인, FE-T7 서버 쪽).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Body, Controller, Delete, HttpCode, Module, Post } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CreateEventHoldBody, CreateEventHoldHeader } from '@peaket/contracts/openapi/seats';
import {
  ContractHeaders,
  ContractRouteSchema,
  CurrentPurchaseSession,
  Idempotent,
  PROBLEM_TYPE_BASE,
  PurchaseSigned,
  Roles,
  createService,
  fakeClock,
  parsePurchaseMac,
  parsePurchaseSeq,
  purchaseMac,
  purchaseMacInput,
  purchaseRequestKey,
  type Principal,
  type PurchaseSession,
  type PurchaseSessionPort,
} from '../src/index.js';
import { collector } from './fixture.js';

interface VectorCase {
  method: string;
  pathAndQuery: string;
  seq: number;
  body: string;
  bodySha256B64u: string;
  macInput: string;
  mac: string;
}
const V = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/purchase-request-mac.v1.json', import.meta.url), 'utf8')) as {
  sharedSecretHex: string;
  jti: string;
  keyHex: string;
  cases: VectorCase[];
};
const KEY = Buffer.from(V.keyHex, 'hex');
const IDEM = '0190f3a1-7c2e-4a00-8000-000000000001';
const FAN = { 'x-user-id': 'acc-1', 'x-session-id': 's-1', 'x-user-aud': 'fan' };

describe('시험 벡터(FE-T7 서버 쪽)', () => {
  test('FND100_공유비밀과jti로_32바이트요청인증키를만든다', () => {
    const key = purchaseRequestKey(Buffer.from(V.sharedSecretHex, 'hex'), V.jti);
    expect(key.length).toBe(32);
    expect(Buffer.from(key).toString('hex')).toBe(V.keyHex);
  });

  test('FND100_MAC입력과MAC이_벡터와같다', () => {
    for (const c of V.cases) {
      const input = purchaseMacInput(c.method, c.pathAndQuery, c.seq, Buffer.from(c.body, 'utf8'));
      expect(input).toBe(c.macInput);
      expect(purchaseMac(KEY, input)).toBe(c.mac);
    }
  });
});

describe('머리 형식', () => {
  test('FND100_일련번호는_앞0없는10진수_1이상_2의53승미만이고_머리는하나다', () => {
    expect(parsePurchaseSeq('1')).toBe(1);
    expect(parsePurchaseSeq('9007199254740991')).toBe(9007199254740991);
    for (const bad of [undefined, '', '0', '01', '-1', '1.0', ' 1', '1e3', '0x10', '9007199254740992', '99999999999999999999', ['1', '2'], 'abc']) {
      expect({ bad, v: parsePurchaseSeq(bad as never) }).toEqual({ bad, v: undefined });
    }
  });

  test('FND100_MAC은_채움없는base64url_43자_32바이트다', () => {
    const mac = V.cases[0]!.mac;
    expect(parsePurchaseMac(mac)?.length).toBe(32);
    for (const bad of [undefined, '', `${mac}=`, mac.slice(1), `${mac}A`, mac.replace(/./, '+'), [mac, mac]]) {
      expect({ bad, v: parsePurchaseMac(bad as never) }).toEqual({ bad, v: undefined });
    }
  });
});

/** 구매 세션 포트 대역: 키 하나, 일련번호는 메모리. 부른 횟수를 센다 */
class FakeSessions implements PurchaseSessionPort {
  readonly last = new Map<string, number>();
  resolved: Principal[] = [];
  advanced: Array<[string, number]> = [];
  missing = false;
  fail: Error | undefined;
  async resolve(_request: FastifyRequest, principal: Principal): Promise<PurchaseSession | undefined> {
    this.resolved.push(principal);
    if (this.fail) throw this.fail;
    if (this.missing) return undefined;
    return { ref: `ps-${principal.sessionId}`, key: KEY };
  }
  async advance(ref: string, seq: number): Promise<boolean> {
    this.advanced.push([ref, seq]);
    if (seq <= (this.last.get(ref) ?? 0)) return false;
    this.last.set(ref, seq);
    return true;
  }
}

@Controller('v1')
class BuyController {
  @HttpCode(201)
  @Post('events/:eventId/holds')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_HOLD' })
  @PurchaseSigned()
  hold(@ContractHeaders(CreateEventHoldHeader) headers: Record<string, unknown>, @CurrentPurchaseSession() ps: string) {
    return { ps, headers };
  }

  @HttpCode(201)
  @Post('rs/events/:eventId/holds')
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_HOLD' })
  @PurchaseSigned()
  @ContractRouteSchema({ headers: CreateEventHoldHeader, body: CreateEventHoldBody })
  holdRs(@Body() body: unknown, @CurrentPurchaseSession() ps: string) {
    return { ps, body };
  }

  @HttpCode(204)
  @Delete('holds/:holdId')
  @Roles(['fan'])
  @PurchaseSigned()
  release() {}

  @HttpCode(200)
  @Post('orders/:orderId/payments')
  @Roles(['fan'])
  @PurchaseSigned()
  pay(@CurrentPurchaseSession() ps: string) {
    return { ps };
  }
}

@Module({ controllers: [BuyController] })
class BuyModule {}

const sessions = new FakeSessions();
let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'buy-svc', module: BuyModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, purchaseSessions: sessions });
});
afterAll(async () => {
  await svc.close();
});

let seq = 0;
/** 서명한 머리. key·seq·본문을 바꿔 서명할 수 있다 */
function signed(method: string, url: string, payload = '', o: { seq?: number; key?: Buffer; extra?: Record<string, string> } = {}) {
  const n = o.seq ?? (seq += 1);
  const mac = purchaseMac(o.key ?? KEY, purchaseMacInput(method, url, n, Buffer.from(payload, 'utf8')));
  return { ...FAN, 'content-type': 'application/json', 'idempotency-key': IDEM, 'x-purchase-seq': String(n), 'x-purchase-mac': mac, ...o.extra };
}
const call = (method: string, url: string, headers: Record<string, string>, payload = '') => svc.http.inject({ method: method as 'POST', url, headers, payload });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const HOLD = '{"seatIds":["A-1"]}';

describe('훅(ADR-0050 결정 8)', () => {
  test('[ASVS v5.0.0-9.1.1] FND100_맞는서명은_처리기가돌고_일련번호를올리며_구매세션참조를받는다', async () => {
    for (const url of ['/v1/events/e1/holds', '/v1/rs/events/e1/holds']) {
      const h = signed('POST', url, HOLD);
      const r = await call('POST', url, h, HOLD);
      expect({ url, status: r.statusCode }).toEqual({ url, status: 201 });
      expect(json(r).ps).toBe('ps-s-1');
      expect(sessions.last.get('ps-s-1')).toBe(Number(h['x-purchase-seq']));
    }
  });

  test('FND100_머리스키마는_두머리를보지않는다(훅만본다)', async () => {
    const url = '/v1/events/e1/holds';
    const r = await call('POST', url, signed('POST', url, HOLD), HOLD);
    // 멱등 키도 멱등 모듈만 보므로(FND-080) 이 표본 머리 스키마에서 남는 칸이 없다
    expect(r.statusCode).toBe(201);
    expect(json(r).headers).toEqual({});
  });

  test('[ASVS v5.0.0-9.1.1] FND100_같은일련번호로다시보내면_401이고_처리기가돌지않는다', async () => {
    const url = '/v1/orders/o-1/payments';
    const h = signed('POST', url, '{}');
    expect((await call('POST', url, h, '{}')).statusCode).toBe(200);
    const again = await call('POST', url, h, '{}');
    expect(again.statusCode).toBe(401);
    // 거절 이유를 type으로 가른다(BAS-040, openapi x-peaket-problem-types, docs/frontend.md §4.1 '401')
    expect(json(again)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}purchase-seq-reused`, title: '이미 받은 요청 번호입니다', status: 401 });
    expect(again.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    // 더 작은 번호도 같다
    const smaller = signed('POST', url, '{}', { seq: Number(h['x-purchase-seq']) - 1 });
    expect((await call('POST', url, smaller, '{}')).statusCode).toBe(401);
  });

  test('[ASVS v5.0.0-11.2.4] FND100_본문메서드경로쿼리일련번호키가다르면_401이고_일련번호를올리지않는다', async () => {
    const url = '/v1/rs/events/e1/holds';
    const before = sessions.last.get('ps-s-1');
    const advancedBefore = sessions.advanced.length;
    const n = (before ?? 0) + 100;
    const cases = [
      { what: '본문', headers: signed('POST', url, HOLD, { seq: n }), url, payload: '{"seatIds":["A-2"]}' },
      { what: '경로', headers: signed('POST', '/v1/rs/events/e2/holds', HOLD, { seq: n }), url, payload: HOLD },
      { what: '쿼리', headers: signed('POST', url, HOLD, { seq: n }), url: `${url}?x=1`, payload: HOLD },
      { what: '메서드', headers: signed('PUT', url, HOLD, { seq: n }), url, payload: HOLD },
      { what: '일련번호', headers: { ...signed('POST', url, HOLD, { seq: n }), 'x-purchase-seq': String(n + 1) }, url, payload: HOLD },
      { what: '키', headers: signed('POST', url, HOLD, { seq: n, key: Buffer.alloc(32, 1) }), url, payload: HOLD },
    ];
    for (const c of cases) {
      const r = await call('POST', c.url, c.headers, c.payload);
      expect({ what: c.what, status: r.statusCode, type: json(r).type }).toEqual({ what: c.what, status: 401, type: `${PROBLEM_TYPE_BASE}purchase-signature-invalid` });
    }
    expect(sessions.advanced.length).toBe(advancedBefore);
    expect(sessions.last.get('ps-s-1')).toBe(before);
  });

  test('FND100_쿼리가든경로와_본문없는요청도_받은그대로서명한다', async () => {
    const url = '/v1/orders/o-1/payments?attempt=2&pg=toss';
    expect((await call('POST', url, signed('POST', url, '{}'), '{}')).statusCode).toBe(200);
    const del = '/v1/holds/h-1';
    const { 'content-type': _c, ...h } = signed('DELETE', del, '');
    expect((await call('DELETE', del, h)).statusCode).toBe(204);
  });

  test('FND100_머리가없거나형식이틀리면_400이아니라401이다(두검사길)', async () => {
    for (const url of ['/v1/events/e1/holds', '/v1/rs/events/e1/holds']) {
      const good = signed('POST', url, HOLD);
      const { 'x-purchase-seq': _s, 'x-purchase-mac': _m, ...none } = good;
      for (const [what, headers] of [
        ['둘 다 없음', none],
        ['일련번호 글자', { ...good, 'x-purchase-seq': 'abc' }],
        ['일련번호 0', { ...good, 'x-purchase-seq': '0' }],
        ['MAC 형식', { ...good, 'x-purchase-mac': 'm' }],
      ] as const) {
        const r = await call('POST', url, headers as Record<string, string>, HOLD);
        expect({ url, what, status: r.statusCode, type: json(r).type }).toEqual({ url, what, status: 401, type: `${PROBLEM_TYPE_BASE}purchase-signature-invalid` });
        expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
      }
    }
  });

  test('FND100_순서_익명401_멱등키400_서명401_모양400', async () => {
    const url = '/v1/rs/events/e1/holds';
    const resolvedBefore = sessions.resolved.length;
    const { 'x-user-id': _u, 'x-session-id': _s, 'x-user-aud': _a, ...anon } = signed('POST', url, '{"seatIds":1}');
    const anonymous = await call('POST', url, anon, '{"seatIds":1}');
    // 신원(팬 쿠키)이 없는 401은 이름 없는 오류 그대로다(화면은 토큰을 한 번 갱신한다)
    expect({ status: anonymous.statusCode, type: json(anonymous).type }).toEqual({ status: 401, type: 'about:blank' });
    expect(sessions.resolved.length).toBe(resolvedBefore);

    const badKey = await call('POST', url, signed('POST', url, '{"seatIds":1}', { extra: { 'idempotency-key': 'k-1', 'x-purchase-mac': 'm' } }), '{"seatIds":1}');
    expect(json(badKey).type).toBe(`${PROBLEM_TYPE_BASE}idempotency-key-invalid`);

    const badMac = await call('POST', url, { ...signed('POST', url, '{"seatIds":1}'), 'x-purchase-mac': V.cases[0]!.mac }, '{"seatIds":1}');
    expect(badMac.statusCode).toBe(401);

    const badShape = await call('POST', url, signed('POST', url, '{"seatIds":1}'), '{"seatIds":1}');
    expect({ status: badShape.statusCode, type: json(badShape).type }).toEqual({ status: 400, type: 'about:blank' });
  });

  test('FND100_구매세션이없으면401이고_포트오류는그대로낸다', async () => {
    const url = '/v1/orders/o-2/payments';
    sessions.missing = true;
    try {
      const r = await call('POST', url, signed('POST', url, '{}'), '{}');
      expect({ status: r.statusCode, type: json(r).type }).toEqual({ status: 401, type: `${PROBLEM_TYPE_BASE}purchase-session-ended` });
    } finally {
      sessions.missing = false;
    }
    const { ProblemError } = await import('../src/index.js');
    sessions.fail = new ProblemError({ type: 'seat-store-unavailable', status: 503, title: '좌석 저장소를 잠시 쓸 수 없습니다', retryAfterSeconds: 1 });
    try {
      const r = await call('POST', url, signed('POST', url, '{}'), '{}');
      expect({ status: r.statusCode, type: json(r).type }).toEqual({ status: 503, type: `${PROBLEM_TYPE_BASE}seat-store-unavailable` });
    } finally {
      sessions.fail = undefined;
    }
  });

  test('FND100_거절은_이유별지표로센다', async () => {
    const url = '/v1/orders/o-3/payments';
    const h = signed('POST', url, '{}');
    await call('POST', url, h, '{}');
    await call('POST', url, h, '{}');
    await call('POST', url, { ...h, 'x-purchase-mac': 'm' }, '{}');
    const m = (await svc.metrics.registry.getMetricsAsJSON()).find((x) => x.name === 'purchase_request_rejections_total');
    const by = Object.fromEntries((m?.values ?? []).map((v) => [v.labels.reason, v.value]));
    expect(by.replay).toBeGreaterThanOrEqual(1);
    expect(by.malformed).toBeGreaterThanOrEqual(1);
    expect(by.mismatch).toBeGreaterThanOrEqual(1);
  });
});

describe('시작 확인', () => {
  const boot = (module: unknown, purchaseSessions?: PurchaseSessionPort) =>
    createService({ name: 'bad-buy-svc', module: module as never, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, purchaseSessions });

  test('FND100_계약이두머리를요구하는데_PurchaseSigned가없으면_두길모두시작실패다', async () => {
    @Controller('v1/f')
    class Forgot {
      @Post('pipe')
      @Roles(['fan'])
      @Idempotent({ operation: 'CREATE_HOLD' })
      pipe(@ContractHeaders(CreateEventHoldHeader) _h: unknown) {
        return {};
      }

      @Post('rs')
      @Roles(['fan'])
      @Idempotent({ operation: 'CREATE_HOLD' })
      @ContractRouteSchema({ headers: CreateEventHoldHeader })
      rs() {
        return {};
      }
    }
    @Module({ controllers: [Forgot] })
    class M {}
    const err = String(await boot(M, new FakeSessions()).catch((e: unknown) => e));
    expect(err).toMatch(/Forgot\.pipe.*PurchaseSigned/);
    expect(err).toMatch(/Forgot\.rs.*PurchaseSigned/);
  });

  test('FND100_공개역할처리기에달거나_포트없이띄우면_시작실패다', async () => {
    @Controller('v1/p')
    class Pub {
      @Post('x')
      @Roles(['public', 'fan'])
      @PurchaseSigned()
      x() {
        return {};
      }
    }
    @Module({ controllers: [Pub] })
    class M1 {}
    await expect(boot(M1, new FakeSessions())).rejects.toThrow(/Pub\.x/);

    @Controller('v1/q')
    class NoPort {
      @Post('x')
      @Roles(['fan'])
      @PurchaseSigned()
      x() {
        return {};
      }
    }
    @Module({ controllers: [NoPort] })
    class M2 {}
    await expect(boot(M2)).rejects.toThrow(/NoPort\.x.*purchaseSessions/);
  });
});
