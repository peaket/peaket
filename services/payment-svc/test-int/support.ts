// payment-svc 통합 시험의 공용 도우미(BUILD_ORDER PRF-180). 실제 gRPC 서버(startGrpcServer, 임의 포트)와 그것을 부르는 생성 클라이언트, 요청·원장 행 만들기.
// - 서버 조립은 main.ts와 같은 재료를 시험에서 직접 묶는다(시계만 가짜: 행의 시각이 시계 값과 같은지 본다). 프로세스 전체 조립은 payment-process.int.test.ts가 본다.
// - 클라이언트는 운영 코드의 paymentPackage()를 쓰지 않고 계약 설명자(@peaket/contracts/proto)에서 따로 만든다(서버의 적재 설정과 부르는 쪽을 따로 본다).
// - 요청의 결제 키·토큰은 시험마다 새 값이고 issuedSecrets에 모은다(로그·오류 글에 실리지 않는지 볼 때 쓴다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { createPlatformLogger, type Database, type FakeClock, fakeClock, PlatformMetrics, systemClock, uuidv7 } from '@peaket/platform';
import { startGrpcServer } from '../src/grpc-server.js';
import { AcceptPaymentCommand, BatchGetPaymentStates, DrizzlePaymentStore, paymentCommandLog, paymentPackage, paymentServiceHandlers, PromPaymentCommandSignals } from '../src/modules/payment/server.js';

/** 설명자를 읽는 선택지(purchase-svc 클라이언트와 같다: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Reply = Record<string, unknown>;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Reply) => void) => grpc.ClientUnaryCall;
export type PaymentClient = grpc.Client & Record<string, Unary>;

/** 계약 설명자로 만든 PaymentService 클라이언트 */
export function paymentClient(address: string): PaymentClient {
  const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
  return new pkg.PaymentService(address, grpc.credentials.createInsecure()) as unknown as PaymentClient;
}

/** 단건 호출(시험 데드라인은 넉넉히 5초. 서버가 끝없이 기다리면 DEADLINE_EXCEEDED로 드러난다) */
export const unary = (client: PaymentClient, method: string, request: object, ms = 5_000): Promise<Reply> =>
  new Promise((resolve, reject) => {
    client[method]!(request, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
  });

/** 실패한 호출의 gRPC 오류(성공하면 시험을 실패시킨다) */
export async function failure(p: Promise<unknown>): Promise<grpc.ServiceError> {
  let reply: unknown;
  try {
    reply = await p;
  } catch (e) {
    return e as grpc.ServiceError;
  }
  throw new Error(`gRPC 오류를 기대했는데 성공했다: ${JSON.stringify(reply)}`);
}

/** 쓰인 결제 키·토큰 모음(로그·오류 글 검사용) */
export const issuedSecrets: string[] = [];
const secret = (prefix: string): string => {
  const v = `${prefix}_${randomUUID()}`;
  issuedSecrets.push(v);
  return v;
};

export const newId = (): string => uuidv7(systemClock);

export interface ConfirmFixture {
  orderId: string;
  attemptId: string;
  eventId: string;
  attemptNo: number;
  amount: number;
  /** 결제창 인증 시각(ms 단위 정수) */
  authenticatedAtMs: number;
  /** ConfirmPaymentRequest(proto 칸 이름) */
  request: Record<string, unknown>;
}

const baseOf = (o: Partial<ConfirmFixture>) => {
  const orderId = o.orderId ?? newId();
  const attemptId = o.attemptId ?? newId();
  const eventId = o.eventId ?? newId();
  const attemptNo = o.attemptNo ?? 1;
  const amount = o.amount ?? 99_000;
  // 지난 시각으로 고정한다(인증 시각 상한은 지금 + 5분이다. 하루의 어느 때 돌려도 지나 있게)
  const authenticatedAtMs = o.authenticatedAtMs ?? Date.parse('2026-11-01T01:02:03.456Z');
  const request = {
    order_id: orderId,
    attempt_id: attemptId,
    event_id: eventId,
    attempt_no: attemptNo,
    amount: { krw: amount },
    authenticated_at: { seconds: Math.floor(authenticatedAtMs / 1000), nanos: (authenticatedAtMs % 1000) * 1_000_000 },
  };
  return { orderId, attemptId, eventId, attemptNo, amount, authenticatedAtMs, request };
};

export interface TossFixture extends ConfirmFixture {
  paymentKey: string;
}

/** 토스(pg 기본) 또는 시뮬레이터의 승인 명령 하나. 시뮬레이터도 toss 칸을 쓴다 */
export function tossConfirm(o: Partial<ConfirmFixture> & { pg?: 'TOSS' | 'SIMULATOR'; paymentKey?: string } = {}): TossFixture {
  const b = baseOf(o);
  const paymentKey = o.paymentKey ?? secret('test_pk');
  return { ...b, paymentKey, request: { ...b.request, pg: `PG_PROVIDER_${o.pg ?? 'TOSS'}`, toss: { payment_key: paymentKey } } };
}

export interface PortoneFixture extends ConfirmFixture {
  paymentId: string;
  txId: string;
  paymentToken: string;
}

/** 포트원 승인 명령 하나. payment_id는 pay-{orderId} */
export function portoneConfirm(o: Partial<ConfirmFixture> = {}): PortoneFixture {
  const b = baseOf(o);
  const paymentId = `pay-${b.orderId}`;
  const txId = `tx-${randomUUID()}`;
  const paymentToken = secret('test_token');
  return { ...b, paymentId, txId, paymentToken, request: { ...b.request, pg: 'PG_PROVIDER_PORTONE', portone: { payment_id: paymentId, tx_id: txId, payment_token: paymentToken } } };
}

// ───────────────────────────── 서버 조립 ─────────────────────────────

export interface GrpcStack {
  address: string;
  client: PaymentClient;
  /** 저장소·쓰임새가 쓰는 시계(가짜. 멈춰 있다) */
  clock: FakeClock;
  store: DrizzlePaymentStore;
  /** 서비스 로거가 쓴 줄(JSON 글) */
  logs: string[];
  /** paymentServiceHandlers의 onError가 받은 것 */
  errors: { method: string; err: unknown }[];
  /** 지표 글 */
  metrics(): Promise<string>;
  close(): Promise<void>;
}

/** 실제 PostgreSQL에 붙은 저장소 + 쓰임새 + gRPC 서버(127.0.0.1, 임의 포트) */
export async function startGrpcStack(o: { hot: Database; batch: Database }): Promise<GrpcStack> {
  const clock = fakeClock({ now: Date.now() });
  const logs: string[] = [];
  const errors: { method: string; err: unknown }[] = [];
  const destination = new Writable({
    write: (chunk, _enc, cb) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) logs.push(l);
      cb();
    },
  });
  const logger = createPlatformLogger({ service: 'payment-svc', env: 'local', version: 'test', clock, level: 'info', destination });
  const metrics = new PlatformMetrics('payment-svc');
  const signals = new PromPaymentCommandSignals();
  signals.register(metrics.registry);
  const store = new DrizzlePaymentStore({ database: o.hot, batchDatabase: o.batch });
  const accept = new AcceptPaymentCommand({ store, clock, log: paymentCommandLog(logger), signals });
  const batchGet = new BatchGetPaymentStates({ reader: store, signals });
  const server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: paymentPackage().PaymentService.service, handlers: paymentServiceHandlers({ accept, batchGet }, (method, err) => errors.push({ method, err })) }],
  });
  const address = `127.0.0.1:${server.port}`;
  const client = paymentClient(address);
  return {
    address,
    client,
    clock,
    store,
    logs,
    errors,
    metrics: () => metrics.registry.metrics(),
    close: async () => {
      client.close();
      await server.close();
    },
  };
}

/** outcome 이름표의 카운터 값(표본이 없으면 0) */
export function outcomeCount(text: string, name: string, outcome: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(`outcome="${outcome}"`));
  return Number(line?.split(' ').at(-1) ?? 0);
}

/** cond가 참이 될 때까지 다시 본다. ms 안에 안 되면 what을 담아 던진다 */
export async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 30_000, every = 100): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이(가) ${ms}ms 안에 오지 않았다`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// ───────────────────────────── 원장 읽기·넣기 ─────────────────────────────

export interface PaymentRow {
  id: string;
  order_id: string;
  event_id: string;
  attempt_id: string;
  attempt_no: number;
  pg: string;
  pg_payment_ref: string;
  pg_confirm_token: string | null;
  amount: number;
  status: string;
  idempotency_key: string;
  authenticated_at: Date;
  created_at: Date;
  approved_at: Date | null;
  status_changed_at: Date;
}

export interface EventRow {
  payment_id: string;
  seq: string;
  event_key: string;
  type: string;
  exported: boolean;
  occurred_at: Date;
}

export interface JobRow {
  payment_id: string;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  attempts: number;
}

/** 관리 풀로 그 주문의 세 표를 읽는다(결제가 없으면 이력·명령은 빈 배열) */
export async function ledgerOf(admin: Database, orderId: string): Promise<{ payments: PaymentRow[]; events: EventRow[]; jobs: JobRow[] }> {
  const payments = (await admin.pool.query('select * from payment where order_id = $1', [orderId])).rows as PaymentRow[];
  const id = payments[0]?.id;
  if (!id) return { payments, events: [], jobs: [] };
  const events = (await admin.pool.query('select * from payment_event where payment_id = $1 order by seq', [id])).rows as EventRow[];
  const jobs = (await admin.pool.query('select * from payment_confirm_job where payment_id = $1', [id])).rows as JobRow[];
  return { payments, events, jobs };
}

/** 세 표 전체의 행 수(쓰지 않았음을 볼 때) */
export async function tableCounts(admin: Database): Promise<{ payment: number; payment_event: number; payment_confirm_job: number }> {
  const r = await admin.pool.query<{ a: string; b: string; c: string }>(
    'select (select count(*) from payment) as a, (select count(*) from payment_event) as b, (select count(*) from payment_confirm_job) as c',
  );
  return { payment: Number(r.rows[0]!.a), payment_event: Number(r.rows[0]!.b), payment_confirm_job: Number(r.rows[0]!.c) };
}

export interface SeededEvent {
  seq: number;
  type: string;
  exported: boolean;
  eventKey: string;
}

export interface SeededPayment {
  paymentId: string;
  orderId: string;
  pg: string;
  amount: number;
  status: string;
  approvedAtMs?: number;
  events: SeededEvent[];
}

/** 결제 한 건과 그 이력을 SQL로 직접 넣는다(BatchGetPayments 시험의 씨앗. 승인 실행기가 아직 없어 수출 사건을 만드는 길이 없다, PRF-181) */
export async function putPayment(
  admin: Database,
  o: { status?: string; pg?: string; amount?: number; approvedAtMs?: number; events?: readonly { seq: number; type: string; exported: boolean }[] } = {},
): Promise<SeededPayment> {
  const paymentId = newId();
  const orderId = newId();
  const pg = o.pg ?? 'TOSS';
  const amount = o.amount ?? 99_000;
  const status = o.status ?? 'ACCEPTED';
  await admin.pool.query(
    `insert into payment (id, order_id, event_id, attempt_id, attempt_no, pg, pg_payment_ref, amount, status, idempotency_key, authenticated_at, created_at, approved_at, status_changed_at)
     values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, now(), now(), $10, now())`,
    [paymentId, orderId, newId(), newId(), pg, `ref-${orderId}`, amount, status, `confirm-${orderId}`, o.approvedAtMs === undefined ? null : new Date(o.approvedAtMs)],
  );
  const events: SeededEvent[] = [];
  for (const e of o.events ?? []) {
    const eventKey = newId();
    await admin.pool.query('insert into payment_event (payment_id, seq, event_key, type, exported, occurred_at) values ($1, $2, $3, $4, $5, now())', [paymentId, e.seq, eventKey, e.type, e.exported]);
    events.push({ ...e, eventKey });
  }
  return { paymentId, orderId, pg, amount, status, ...(o.approvedAtMs === undefined ? {} : { approvedAtMs: o.approvedAtMs }), events };
}

/** google.protobuf.Timestamp 답 → epoch ms */
export const msOf = (t: unknown): number => {
  const v = t as { seconds: number; nanos: number };
  return v.seconds * 1000 + Math.floor(v.nanos / 1_000_000);
};
