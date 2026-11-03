// 시뮬레이터 HTTP 경로. 토스페이먼츠 모양 API(승인·조회·주문 ID 조회·취소)와 시험용 제어 API(/sim/*).
// 둘 다 시험 키 기본 인증(`Authorization: Basic base64(키 + ':')`)이 있어야 한다(ASVS v5.0.0-8.2.1). 요청 로그는 남기지 않는다(16.2.5).
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { OPS, PgSimulatorEngine, type Fault, type SimResponse } from './engine.js';
import { parseLatencySpec, type LatencySpec } from './latency.js';
import type { SimClock } from './time.js';

export interface SimulatorAppOptions {
  /** sim_sk_로 시작하는 시험 키 */
  secretKey: string;
  clock?: SimClock;
  sleep?: (ms: number) => Promise<void>;
  /** 지연 난수의 시드(없으면 Math.random) */
  seed?: number;
  confirmLatency?: LatencySpec;
}

export type SimulatorApp = FastifyInstance;

const KEY_PARAM = { type: 'object', required: ['paymentKey'], properties: { paymentKey: { type: 'string', minLength: 1, maxLength: 200 } } } as const;
const IDEM_HEADER = { type: 'object', properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 300 } } } as const;
const AMOUNT = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const ORDER = { type: 'string', pattern: '^[A-Za-z0-9_-]{6,64}$' } as const;

export function buildSimulatorApp(o: SimulatorAppOptions): SimulatorApp {
  const engine = new PgSimulatorEngine({ clock: o.clock, sleep: o.sleep, seed: o.seed, confirmLatency: o.confirmLatency });
  const expected = Buffer.from(`Basic ${Buffer.from(`${o.secretKey}:`).toString('base64')}`);
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED_KEY', message: '인증되지 않은 키입니다' });
    }
  });
  app.setErrorHandler((e: { validation?: unknown; statusCode?: number }, _req, reply) => {
    if (e.validation || (e.statusCode !== undefined && e.statusCode >= 400 && e.statusCode < 500)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: '요청이 틀렸습니다' });
    }
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

  // ---- 시험용 제어 API ----
  app.post<{ Body: { orderId: string; amount: number; orderName?: string } }>(
    '/sim/authenticate',
    {
      schema: {
        body: { type: 'object', required: ['orderId', 'amount'], additionalProperties: false, properties: { orderId: ORDER, amount: AMOUNT, orderName: { type: 'string', minLength: 1, maxLength: 100 } } },
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
