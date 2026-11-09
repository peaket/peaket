// 시뮬레이터 HTTP 경로. 토스페이먼츠 모양 API(승인·조회·주문 ID 조회·취소), 포트원 V2 모양 API(`/payments/...`, BUILD_ORDER HOT-140)와 시험용 제어 API(/sim/*).
// 토스 모양·제어 API는 시험 키 기본 인증(`Authorization: Basic base64(키 + ':')`), 포트원 모양은 `Authorization: PortOne 키`가 있어야 한다(ASVS v5.0.0-8.2.1). 요청 로그는 남기지 않는다(16.2.5).
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { OPS, PgSimulatorEngine, PORTONE_IDEMPOTENCY_RETENTION_MS, SIM_PAY_METHODS, type Fault, type SeedTransaction, type SimInstrument, type SimResponse } from './engine.js';
import { parseLatencySpec, type LatencySpec } from './latency.js';
import { defaultPortoneWebhookSecret, parsePortoneIdempotencyKey, portoneAuthenticateResponse, portoneCancelResponse, portoneConfirmResponse, portoneQueryResponse, PORTONE_STORE_ID, portoneTransactionView, portoneWebhookEvents } from './portone-shape.js';
import type { SimClock } from './time.js';

export interface SimulatorAppOptions {
  /** sim_sk_로 시작하는 시험 키 */
  secretKey: string;
  clock?: SimClock;
  sleep?: (ms: number) => Promise<void>;
  /** 지연 난수의 시드(없으면 Math.random) */
  seed?: number;
  confirmLatency?: LatencySpec;
  /** 포트원 모양 웹훅 서명 시크릿(whsec_ + base64). 없으면 시험 키에서 만든다 */
  portoneWebhookSecret?: string;
}

export type SimulatorApp = FastifyInstance;

const PAYMENT_ID_PARAM = { type: 'object', required: ['paymentId'], properties: { paymentId: { type: 'string', minLength: 1, maxLength: 200 } } } as const;

const KEY_PARAM = { type: 'object', required: ['paymentKey'], properties: { paymentKey: { type: 'string', minLength: 1, maxLength: 200 } } } as const;
const IDEM_HEADER = { type: 'object', properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 300 } } } as const;
const AMOUNT = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const ORDER = { type: 'string', pattern: '^[A-Za-z0-9_-]{6,64}$' } as const;
/** 결제창 인증이 받는 시험 결제 수단(BUILD_ORDER HOT-145) */
const INSTRUMENT = {
  method: { type: 'string', enum: SIM_PAY_METHODS },
  card: {
    type: ['object', 'null'],
    required: ['number'],
    additionalProperties: false,
    properties: { number: { type: 'string', minLength: 1, maxLength: 20 }, issuerCode: { type: ['string', 'null'], maxLength: 40 }, cardType: { type: 'string', maxLength: 10 }, bin: { type: ['string', 'null'], maxLength: 8 } },
  },
} as const;

export function buildSimulatorApp(o: SimulatorAppOptions): SimulatorApp {
  const engine = new PgSimulatorEngine({ clock: o.clock, sleep: o.sleep, seed: o.seed, confirmLatency: o.confirmLatency });
  const expected = Buffer.from(`Basic ${Buffer.from(`${o.secretKey}:`).toString('base64')}`);
  const expectedPortone = Buffer.from(`PortOne ${o.secretKey}`);
  const portoneWebhookSecret = o.portoneWebhookSecret ?? defaultPortoneWebhookSecret(o.secretKey);
  const app = Fastify({ logger: false });
  const isPortone = (req: FastifyRequest) => req.url.startsWith('/payments/') || req.url.startsWith('/payments-by-cursor');

  app.addHook('onRequest', async (req, reply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    const portone = isPortone(req);
    const want = portone ? expectedPortone : expected;
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return reply.code(401).send(portone ? { type: 'UNAUTHORIZED', message: '인증되지 않은 키입니다' } : { code: 'UNAUTHORIZED_KEY', message: '인증되지 않은 키입니다' });
    }
  });
  app.setErrorHandler((e: { validation?: unknown; statusCode?: number }, req, reply) => {
    const portone = isPortone(req);
    if (e.validation || (e.statusCode !== undefined && e.statusCode >= 400 && e.statusCode < 500)) {
      return reply.code(400).send(portone ? { type: 'INVALID_REQUEST', message: '요청이 틀렸습니다' } : { code: 'INVALID_REQUEST', message: '요청이 틀렸습니다' });
    }
    if (portone) return reply.code(502).send({ type: 'PG_PROVIDER', message: '시뮬레이터 내부 오류입니다' });
    return reply.code(500).send({ code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '시뮬레이터 내부 오류입니다' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: '없는 경로입니다' }));

  const send = (req: FastifyRequest, reply: FastifyReply, r: SimResponse) => {
    if (r.drop) {
      // 응답 유실: 응답을 쓰지 않고 연결을 끊는다(어댑터에서는 결과 모름)
      reply.hijack();
      req.raw.socket?.destroy();
      return;
    }
    return reply.code(r.status).send(r.body);
  };
  const idemOf = (req: FastifyRequest) => (req.headers['idempotency-key'] as string | undefined) ?? undefined;

  // ---- 결제사 모양 API ----
  app.post<{ Body: { paymentKey: string; orderId: string; amount: number } }>(
    '/v1/payments/confirm',
    {
      schema: {
        headers: IDEM_HEADER,
        body: { type: 'object', required: ['paymentKey', 'orderId', 'amount'], additionalProperties: false, properties: { paymentKey: KEY_PARAM.properties.paymentKey, orderId: ORDER, amount: AMOUNT } },
      },
    },
    async (req, reply) => send(req, reply, await engine.confirm(req.body, idemOf(req))),
  );
  app.get<{ Params: { paymentKey: string } }>('/v1/payments/:paymentKey', { schema: { params: KEY_PARAM } }, async (req, reply) =>
    send(req, reply, await engine.query(req.params.paymentKey)),
  );
  app.get<{ Params: { orderId: string } }>(
    '/v1/payments/orders/:orderId',
    { schema: { params: { type: 'object', required: ['orderId'], properties: { orderId: ORDER } } } },
    async (req, reply) => send(req, reply, await engine.queryByOrder(req.params.orderId)),
  );
  app.post<{ Params: { paymentKey: string }; Body: { cancelReason: string; cancelAmount?: number } }>(
    '/v1/payments/:paymentKey/cancel',
    {
      schema: {
        params: KEY_PARAM,
        headers: IDEM_HEADER,
        body: { type: 'object', required: ['cancelReason'], additionalProperties: false, properties: { cancelReason: { type: 'string', minLength: 1, maxLength: 200 }, cancelAmount: AMOUNT } },
      },
    },
    async (req, reply) => send(req, reply, await engine.cancel(req.params.paymentKey, req.body, idemOf(req))),
  );

  // 거래 조회(대사, BUILD_ORDER HOT-153)
  app.get<{ Querystring: { startDate: string; endDate: string; startingAfter?: string; limit?: number } }>(
    '/v1/transactions',
    { schema: { querystring: { type: 'object', required: ['startDate', 'endDate'], additionalProperties: false, properties: { startDate: { type: 'string', maxLength: 40 }, endDate: { type: 'string', maxLength: 40 }, startingAfter: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 10_000 } } } } },
    async (req) => engine.transactions({ startDate: req.query.startDate, endDate: req.query.endDate, limit: req.query.limit ?? 100, ...(req.query.startingAfter === undefined ? {} : { startingAfter: req.query.startingAfter }) }),
  );

  // ---- 포트원 V2 모양 API(같은 원장, 같은 장애 넣기, BUILD_ORDER HOT-140) ----
  const portoneIdemOf = (req: FastifyRequest, reply: FastifyReply): string | undefined | 'BAD' => {
    const key = parsePortoneIdempotencyKey(req.headers['idempotency-key']);
    if (key !== null) return key;
    void reply.code(400).send({ type: 'INVALID_REQUEST', message: '멱등키 형식이 틀렸습니다' });
    return 'BAD';
  };
  const orderIdOf = (paymentId: string) => (paymentId.startsWith('pay-') ? paymentId.slice(4) : paymentId);
  /** 상점 ID를 생략하면 인증 정보의 상점이다. 다르면 없는 결제와 같은 답이다(잘못된 상점 설정은 기록 없음과 가려지지 않는다) */
  const wrongStore = (storeId: string | undefined, reply: FastifyReply): boolean => {
    if (storeId === undefined || storeId === PORTONE_STORE_ID) return false;
    void reply.code(404).send({ type: 'PAYMENT_NOT_FOUND', message: '결제를 찾을 수 없습니다' });
    return true;
  };

  app.post<{ Params: { paymentId: string }; Body: { paymentToken: string; totalAmount: number; currency: string; isTest?: boolean; storeId?: string; txId?: string } }>(
    '/payments/:paymentId/confirm',
    {
      schema: {
        params: PAYMENT_ID_PARAM,
        body: {
          type: 'object',
          required: ['paymentToken', 'totalAmount', 'currency'],
          additionalProperties: false,
          properties: { paymentToken: { type: 'string', minLength: 1, maxLength: 200 }, totalAmount: AMOUNT, currency: { type: 'string', minLength: 1, maxLength: 8 }, isTest: { type: 'boolean' }, storeId: { type: 'string', maxLength: 200 }, txId: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const idem = portoneIdemOf(req, reply);
      if (idem === 'BAD' || wrongStore(req.body.storeId, reply)) return reply;
      // 시뮬레이터는 시험 채널이다: KRW와 시험 결제만 받는다
      if (req.body.currency !== 'KRW' || req.body.isTest === false) return reply.code(409).send({ type: 'INFORMATION_MISMATCH', message: '결제 정보가 다릅니다' });
      const c = { paymentKey: req.params.paymentId, orderId: orderIdOf(req.params.paymentId), amount: req.body.totalAmount };
      return send(req, reply, portoneConfirmResponse(await engine.confirm(c, idem, { retentionMs: PORTONE_IDEMPOTENCY_RETENTION_MS, token: req.body.paymentToken, ...(req.body.txId === undefined ? {} : { txId: req.body.txId }) })));
    },
  );
  app.get<{ Params: { paymentId: string }; Querystring: { storeId?: string } }>(
    '/payments/:paymentId',
    { schema: { params: PAYMENT_ID_PARAM, querystring: { type: 'object', additionalProperties: false, properties: { storeId: { type: 'string', maxLength: 200 } } } } },
    async (req, reply) => (wrongStore(req.query.storeId, reply) ? reply : send(req, reply, portoneQueryResponse(await engine.query(req.params.paymentId)))),
  );
  app.post<{ Params: { paymentId: string }; Body: { reason: string; amount?: number; currentCancellableAmount?: number; storeId?: string } }>(
    '/payments/:paymentId/cancel',
    {
      schema: {
        params: PAYMENT_ID_PARAM,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: 200 }, amount: AMOUNT, currentCancellableAmount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, storeId: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const idem = portoneIdemOf(req, reply);
      if (idem === 'BAD' || wrongStore(req.body.storeId, reply)) return reply;
      const body = { cancelReason: req.body.reason, ...(req.body.amount === undefined ? {} : { cancelAmount: req.body.amount }) };
      const options = { retentionMs: PORTONE_IDEMPOTENCY_RETENTION_MS, ...(req.body.currentCancellableAmount === undefined ? {} : { currentCancellableAmount: req.body.currentCancellableAmount }) };
      return send(req, reply, portoneCancelResponse(await engine.cancel(req.params.paymentId, body, idem, options)));
    },
  );

  // 포트원 결제 대용량 다건 조회(대사, BUILD_ORDER HOT-153). 다른 상점이면 빈 답이다(응답이 목록이라 404를 쓰지 않는다)
  app.get<{ Querystring: { storeId?: string; from: string; until: string; cursor?: string; size?: number } }>(
    '/payments-by-cursor',
    { schema: { querystring: { type: 'object', required: ['from', 'until'], additionalProperties: false, properties: { storeId: { type: 'string', maxLength: 200 }, from: { type: 'string', maxLength: 40 }, until: { type: 'string', maxLength: 40 }, cursor: { type: 'string', maxLength: 40 }, size: { type: 'integer', minimum: 1, maximum: 10_000 } } } } },
    async (req) => {
      if (req.query.storeId !== undefined && req.query.storeId !== PORTONE_STORE_ID) return { items: [] };
      const page = engine.portonePaymentsByCursor({ from: req.query.from, until: req.query.until, size: req.query.size ?? 1000, ...(req.query.cursor === undefined ? {} : { cursor: req.query.cursor }) });
      return { items: page.items.map(portoneTransactionView), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
    },
  );

  // ---- 시험용 제어 API ----
  app.post<{ Body: { items: SeedTransaction[] } }>(
    '/sim/transactions/seed',
    {
      // 측정(10만 건)의 씨앗이라 기본 본문 상한(1MB)을 넓힌다
      bodyLimit: 64 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['items'],
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              items: { type: 'object', required: ['paymentKey', 'orderId', 'amount', 'status', 'atMs'], additionalProperties: false, properties: { paymentKey: { type: 'string', minLength: 1, maxLength: 200 }, orderId: ORDER, amount: AMOUNT, status: { type: 'string', enum: ['DONE', 'PARTIAL_CANCELED', 'CANCELED', 'WAITING_FOR_DEPOSIT'] }, atMs: { type: 'integer' } } },
            },
          },
        },
      },
    },
    async (req) => ({ inserted: engine.seedTransactions(req.body.items) }),
  );
  app.post<{ Body: { orderId: string; amount: number; orderName?: string } & SimInstrument }>(
    '/sim/portone/authenticate',
    {
      schema: {
        body: { type: 'object', required: ['orderId', 'amount'], additionalProperties: false, properties: { orderId: ORDER, amount: AMOUNT, orderName: { type: 'string', minLength: 1, maxLength: 100 }, ...INSTRUMENT } },
      },
    },
    async (req, reply) => send(req, reply, portoneAuthenticateResponse(engine.authenticatePortone(req.body))),
  );
  app.get<{ Querystring: { paymentId?: string } }>(
    '/sim/portone/webhooks',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { paymentId: PAYMENT_ID_PARAM.properties.paymentId } } } },
    async (req) => portoneWebhookEvents(engine.webhooks(req.query.paymentId), portoneWebhookSecret),
  );
  app.post<{ Body: { orderId: string; amount: number; orderName?: string } & SimInstrument }>(
    '/sim/authenticate',
    {
      schema: {
        body: { type: 'object', required: ['orderId', 'amount'], additionalProperties: false, properties: { orderId: ORDER, amount: AMOUNT, orderName: { type: 'string', minLength: 1, maxLength: 100 }, ...INSTRUMENT } },
      },
    },
    async (req, reply) => send(req, reply, engine.authenticate(req.body)),
  );
  app.post<{ Body: Record<string, unknown> }>('/sim/faults', async (req, reply) => {
    const f = parseFault(req.body);
    if (!f) return reply.code(400).send({ code: 'INVALID_REQUEST', message: '장애 설정이 틀렸습니다' });
    engine.addFault(f);
    return reply.code(204).send();
  });
  app.delete('/sim/faults', async (_req, reply) => {
    engine.clearFaults();
    return reply.code(204).send();
  });
  app.put<{ Body: unknown }>('/sim/latency', async (req, reply) => {
    let spec: LatencySpec;
    try {
      spec = parseLatencySpec(req.body);
    } catch {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: '지연 설정이 틀렸습니다' });
    }
    engine.setLatency(spec);
    return reply.code(204).send();
  });
  app.get('/sim/ledger', async (_req, reply) => {
    const body = engine.ledger().map((r) => `${JSON.stringify(r)}\n`).join('');
    return reply.code(200).header('content-type', 'application/x-ndjson; charset=utf-8').send(body);
  });
  app.get<{ Querystring: { paymentKey?: string } }>(
    '/sim/webhooks',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { paymentKey: KEY_PARAM.properties.paymentKey } } } },
    async (req) => engine.webhooks(req.query.paymentKey),
  );
  app.post<{ Params: { paymentKey: string } }>('/sim/deposits/:paymentKey', { schema: { params: KEY_PARAM } }, async (req, reply) => send(req, reply, engine.deposit(req.params.paymentKey)));
  app.post<{ Params: { paymentKey: string }; Body?: { dueDate?: string } }>('/sim/deposits/:paymentKey/reverse', { schema: { params: KEY_PARAM } }, async (req, reply) => send(req, reply, engine.reverseDeposit(req.params.paymentKey, req.body ?? {})));
  app.post<{ Params: { paymentKey: string } }>('/sim/deposits/:paymentKey/expire', { schema: { params: KEY_PARAM } }, async (req, reply) => send(req, reply, engine.expireDeposit(req.params.paymentKey)));
  app.get<{ Querystring: { orderId?: string } }>(
    '/sim/deposit-callbacks',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { orderId: ORDER } } } },
    async (req) => engine.depositCallbacks(req.query.orderId),
  );
  app.post('/sim/reset', async (_req, reply) => {
    engine.reset();
    return reply.code(204).send();
  });

  return app;
}

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** 제어 API의 장애 설정을 검사한다. 틀리면 undefined */
export function parseFault(v: unknown): Fault | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!(OPS as readonly unknown[]).includes(o.op)) return undefined;
  if (o.orderId !== undefined && (typeof o.orderId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(o.orderId))) return undefined;
  if (o.times !== undefined && !(Number.isInteger(o.times) && (o.times as number) > 0)) return undefined;
  const base = { op: o.op as Fault['op'], ...(o.orderId === undefined ? {} : { orderId: o.orderId as string }), ...(o.times === undefined ? {} : { times: o.times as number }) };
  switch (o.kind) {
    case 'decline':
      if (typeof o.code !== 'string' || !CODE.test(o.code)) return undefined;
      if (o.message !== undefined && (typeof o.message !== 'string' || o.message.length > 200)) return undefined;
      return { ...base, kind: 'decline', code: o.code, ...(o.message === undefined ? {} : { message: o.message as string }) };
    case 'in-progress':
    case 'throttle':
      return { ...base, kind: o.kind };
    case 'pg-error':
    case 'drop':
      if (typeof o.applied !== 'boolean') return undefined;
      return { ...base, kind: o.kind, applied: o.applied };
    case 'delay':
      if (!(Number.isInteger(o.ms) && (o.ms as number) >= 0 && (o.ms as number) <= 120_000)) return undefined;
      return { ...base, kind: 'delay', ms: o.ms as number };
    default:
      return undefined;
  }
}
