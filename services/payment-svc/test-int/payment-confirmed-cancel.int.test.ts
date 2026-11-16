// 결제 후 일반 취소(GAT-080, docs/features/payment.md §4.1)를 실제 PostgreSQL 18과 실제 gRPC 서버로 돈다.
// 부분·전액 취소, 같은 취소 ID 재요청, 결제사 CANCEL_PENDING·UNKNOWN의 원장 무변경, cancelled_amount 누적·CHECK를 본다.
// 결제사만 기록 대역이다(멱등키 cancel-{cancellationId}와 금액을 본다).
// BAT-415 몫 P(docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', P-T21): 0021 payment_cancel, 저장한 본문 그대로 재전송, 한 번에 하나(10분),
// 끝남은 그 건의 CANCELED로만, 겹친 재시도의 한 번 반영, 3시간 지난 재시도의 조회 대조. 시간은 정본 값을 글자로 적고 가짜 시계를 앞으로만 돌린다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import {
  CancelConfirmedPayment,
  CancelPayment,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  GetPaymentDetail,
  NoKeyVirtualAccountCipher,
  paymentPackage,
  paymentServiceHandlers,
} from '../src/modules/payment/server.js';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import { migratePayment } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { failure, newId, type PaymentClient, paymentClient, putPayment, unary } from './support.js';

const NOW = Date.parse('2026-11-13T01:00:00.000Z');
const PRICE = 100_000;

let pgc: PostgresContainer | undefined;
let admin: Database;
let hot: Database;
let client: PaymentClient | undefined;
let server: { port: number; close(): Promise<void> } | undefined;
let gatewayOutcome: CancelResult['outcome'] = 'CANCELLED';
let gatewayCalls: Parameters<PaymentGatewayPort['cancel']>[0][] = [];
let queryAnswer: QueryResult = { kind: 'UNKNOWN' };
let queryCalls: string[] = [];
/** 장애 주입: 결제사 대역이 need개의 호출이 모두 들어올 때까지 답을 붙잡는다(3초 넘게 안 오면 놓아 시험이 멈추지 않게 한다) */
let barrier: { need: number; arrived: number; release: () => void; done: Promise<void> } | undefined;
const holdUntil = (need: number): void => {
  let release = (): void => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, 3_000).unref();
  });
  barrier = { need, arrived: 0, release, done };
};

const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  admin = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'confirmed-cancel-it-admin' });
  hot = createDatabase({ url: pgc.url, profile: 'general', max: 8, applicationName: 'confirmed-cancel-it-hot' });
  const jobs = new DrizzleConfirmJobs({ database: hot, clock });
  const store = new DrizzlePaymentStore({ database: hot, batchDatabase: hot });
  const gateway = {
    pg: 'TOSS',
    cancel: async (c: Parameters<PaymentGatewayPort['cancel']>[0]) => {
      gatewayCalls.push(c);
      const b = barrier;
      if (b) {
        b.arrived += 1;
        if (b.arrived >= b.need) b.release();
        await b.done;
      }
      return { outcome: gatewayOutcome };
    },
    query: async (paymentRef: string) => {
      queryCalls.push(paymentRef);
      return queryAnswer;
    },
  } as unknown as PaymentGatewayPort;
  const confirmed = new CancelConfirmedPayment({
    store: jobs,
    gateways: { of: () => gateway },
    guards: { of: () => ({ circuitClosed: () => true, tryTakeToken: () => true }) as never },
    clock,
  });
  const cancelPayment = new CancelPayment({ execute: async () => Promise.reject(new Error('입금 전 취소 갈래가 아니다')) } as never, confirmed, jobs);
  const getPayment = new GetPaymentDetail({
    reader: store,
    signals: { getPayment: () => {} },
    cipher: new NoKeyVirtualAccountCipher(),
    depositLog: { infoMissing: () => {}, accountUnsaved: () => {}, accountUnopened: () => {} },
    depositSignals: { fieldFailure: () => {} },
    clock,
  });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: paymentPackage().PaymentService.service,
        handlers: paymentServiceHandlers(
          {
            accept: { execute: async () => Promise.reject(new Error('이 시험은 승인 명령을 부르지 않는다')) } as never,
            batchGet: { execute: async () => Promise.reject(new Error('이 시험은 결과 당기기를 부르지 않는다')) } as never,
            getPayment,
            cancelPayment,
          },
          () => {},
        ),
      },
    ],
  });
  client = paymentClient(`127.0.0.1:${server.port}`);
}, 180_000);

afterAll(async () => {
  client?.close();
  await server?.close();
  await Promise.allSettled([admin?.close(), hot?.close()]);
  pgc?.stop();
});

beforeEach(async () => {
  // payment_cancel(0021)이 payment를 가리키므로 cascade로 함께 비운다
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job cascade');
  gatewayOutcome = 'CANCELLED';
  gatewayCalls = [];
  queryAnswer = { kind: 'UNKNOWN' };
  queryCalls = [];
  barrier = undefined;
});

const cancel = (paymentId: string, cancellationId: string, amount?: number, reason = '관객 취소') =>
  unary(client!, 'CancelPayment', { payment_id: paymentId, cancellation_id: cancellationId, reason, ...(amount === undefined ? {} : { amount: { krw: amount } }) });
const rowOf = async (paymentId: string) =>
  (await admin.pool.query('select status, cancelled_amount from payment where id = $1', [paymentId])).rows[0] as { status: string; cancelled_amount: number };
const eventsOf = async (paymentId: string) =>
  (await admin.pool.query('select type, exported from payment_event where payment_id = $1 order by seq', [paymentId])).rows as { type: string; exported: boolean }[];

describe('0014 payment.cancelled_amount', () => {
  test('GAT080_0014는_cancelled_amount와_누적액이_결제액을_넘지_않는_CHECK를_만든다', async () => {
    const cols = await admin.pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'payment' and column_name = 'cancelled_amount'",
    );
    expect(cols.rows).toEqual([{ data_type: 'integer', is_nullable: 'NO', column_default: '0' }]);
    const check = await admin.pool.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.payment'::regclass and conname = 'payment_cancelled_amount_check'",
    );
    expect(check.rows[0]?.def).toContain('cancelled_amount >= 0');
    expect(check.rows[0]?.def).toContain('cancelled_amount <= amount');
    const seeded = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    await expect(admin.pool.query('update payment set cancelled_amount = amount + 1 where id = $1', [seeded.paymentId])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('결제 후 일반 취소', () => {
  test('GAT080_부분취소는_요청액만_결제사에_넘기고_cancelled_amount에_더한다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    await expect(cancel(p.paymentId, 'cancel_01', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 30_000 } });
    expect(gatewayCalls).toHaveLength(1);
    expect(gatewayCalls[0]).toMatchObject({ paymentRef: `ref-${p.orderId}`, amount: 30_000, reason: '관객 취소', idemKey: 'cancel-cancel_01' });
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 30_000 });
    expect(await eventsOf(p.paymentId)).toEqual([{ type: 'CONFIRMED_CANCEL_SENT', exported: false }]);
    await expect(unary(client!, 'GetPayment', { payment_id: p.paymentId })).resolves.toMatchObject({ status: 'PAYMENT_STATUS_PARTIAL_CANCELED', cancelled_amount: { krw: 30_000 } });
  });

  test('GAT080_부분취소를_두번_더하고_남은금액을_비우면_ALL로_전액취소하며_같은취소ID는_결제사를_다시부르지_않는다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    await expect(cancel(p.paymentId, 'cancel_01', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 30_000 } });
    await expect(cancel(p.paymentId, 'cancel_02', 20_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 50_000 });

    await expect(cancel(p.paymentId, 'cancel_03')).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: PRICE } });
    expect(gatewayCalls).toHaveLength(3);
    expect(gatewayCalls[2]).toMatchObject({ amount: 'ALL', idemKey: 'cancel-cancel_03' });
    expect(await rowOf(p.paymentId)).toEqual({ status: 'CANCELED', cancelled_amount: PRICE });

    await expect(cancel(p.paymentId, 'cancel_03')).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: PRICE } });
    expect(gatewayCalls).toHaveLength(3);
    expect((await eventsOf(p.paymentId)).filter((e) => e.type === 'CONFIRMED_CANCEL_SENT')).toHaveLength(3);
  });

  test.each(['CANCEL_PENDING', 'UNKNOWN'] as const)('GAT080_결제사_%s는_원장을_바꾸지_않고_같은멱등키로_다시부를수_있다', async (outcome) => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = outcome;
    await expect(cancel(p.paymentId, 'cancel_01', 30_000)).resolves.toMatchObject({ result: `CANCEL_RESULT_${outcome}`, cancelled_amount: { krw: 0 } });
    expect(await rowOf(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect(gatewayCalls).toHaveLength(1);

    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'cancel_01', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 30_000 } });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[0]!.idemKey).toBe(gatewayCalls[1]!.idemKey);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 30_000 });
    expect((await eventsOf(p.paymentId)).filter((e) => e.type === 'CONFIRMED_CANCEL_SENT')).toHaveLength(1);
  });

  test('GAT080_남은금액보다_큰요청은_INVALID_ARGUMENT이고_결제사를_부르지_않는다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    await cancel(p.paymentId, 'cancel_01', 90_000);
    gatewayCalls = [];
    expect((await failure(cancel(p.paymentId, 'cancel_02', 20_000))).code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(gatewayCalls).toHaveLength(0);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 90_000 });
  });

  test('GAT080_승인전_결제와_없는결제는_원장을_바꾸지_않는다', async () => {
    const failed = await putPayment(admin, { status: 'FAILED', amount: PRICE });
    expect((await failure(cancel(failed.paymentId, 'cancel_01'))).code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(await rowOf(failed.paymentId)).toEqual({ status: 'FAILED', cancelled_amount: 0 });
    expect((await failure(cancel(newId(), 'cancel_01'))).code).toBe(grpc.status.NOT_FOUND);
    expect(gatewayCalls).toHaveLength(0);
  });
});

// ---- BAT-415 몫 P: 취소 건 기록과 기대 잔액(docs/features/payment.md §4.1, docs/data.md payment_cancel·§5) ----

interface CancelRow {
  idempotency_key: string;
  amount: number;
  reason: string;
  full_cancel: boolean;
  expected_balance: number;
  status: string;
}
const cancelRows = async (paymentId: string): Promise<CancelRow[]> =>
  (
    await admin.pool.query<CancelRow>(
      'select idempotency_key, amount, reason, full_cancel, expected_balance, status from payment_cancel where payment_id = $1 order by created_at, idempotency_key',
      [paymentId],
    )
  ).rows;
/** 결제 100,000원 중 20,000원이 이미 취소된 원장(남은 80,000원) */
const partial = async () => {
  const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
  await admin.pool.query("update payment set cancelled_amount = 20000, status = 'PARTIAL_CANCELED' where id = $1", [p.paymentId]);
  return p;
};
const body = (orderId: string, idem: string, amount: number | 'ALL', expectedBalance: number, reason = '관객 취소') => ({
  paymentRef: `ref-${orderId}`,
  amount,
  reason,
  idemKey: `cancel-${idem}`,
  expectedBalance,
});

describe('GAT-080 몫 P 취소 건 기록과 기대 잔액', () => {
  test('GAT-080 P1 실제 저장소: 결제 100,000·누적 20,000에 요청 30,000은 금액 30,000·기대 잔액 80,000, 남은 전부 80,000과 금액 없음은 ALL이다', async () => {
    const a = await partial();
    await expect(cancel(a.paymentId, 'p1_part', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(gatewayCalls).toEqual([body(a.orderId, 'p1_part', 30_000, 80_000)]);
    expect(await cancelRows(a.paymentId)).toEqual([{ idempotency_key: 'cancel-p1_part', amount: 30_000, reason: '관객 취소', full_cancel: false, expected_balance: 80_000, status: 'CANCELED' }]);

    const b = await partial();
    await expect(cancel(b.paymentId, 'p1_full', 80_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: PRICE } });
    expect(gatewayCalls.at(-1)).toEqual(body(b.orderId, 'p1_full', 'ALL', 80_000));
    expect(await cancelRows(b.paymentId)).toEqual([{ idempotency_key: 'cancel-p1_full', amount: 80_000, reason: '관객 취소', full_cancel: true, expected_balance: 80_000, status: 'CANCELED' }]);
    expect(await rowOf(b.paymentId)).toEqual({ status: 'CANCELED', cancelled_amount: PRICE });

    const c = await partial();
    await expect(cancel(c.paymentId, 'p1_omit')).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: PRICE } });
    expect(gatewayCalls.at(-1)).toEqual(body(c.orderId, 'p1_omit', 'ALL', 80_000));
    expect(await cancelRows(c.paymentId)).toEqual([{ idempotency_key: 'cancel-p1_omit', amount: 80_000, reason: '관객 취소', full_cancel: true, expected_balance: 80_000, status: 'CANCELED' }]);
  });

  test('GAT-080 P2 결과 모름 뒤 재시도는 원장을 다시 계산하지 않고 첫 본문(금액·ALL 여부·기대 잔액·사유·멱등키)을 그대로 보낸다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'UNKNOWN';
    await expect(cancel(p.paymentId, 'p2', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 0 } });
    // 그사이 원장이 바뀐다(다른 경로의 반영을 흉내): 다시 계산하면 기대 잔액이 95,000이 된다
    await admin.pool.query("update payment set cancelled_amount = 5000, status = 'PARTIAL_CANCELED' where id = $1", [p.paymentId]);
    await expect(cancel(p.paymentId, 'p2', 30_000, '다시 보낸 다른 사유')).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN' });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[0]).toEqual(body(p.orderId, 'p2', 30_000, PRICE));
    expect(gatewayCalls[1]).toEqual(gatewayCalls[0]);
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: 'cancel-p2', amount: 30_000, reason: '관객 취소', full_cancel: false, expected_balance: PRICE, status: 'REQUESTED' }]);
  });

  test('GAT-080 P3 같은 결제의 다른 취소가 10분 안(599,999ms)이면 보내지 않고 결과 모름, 600,000ms면 보내며, 앞 취소 반영 뒤에는 새 잔액으로 보낸다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p3_x', 30_000);
    expect(gatewayCalls).toHaveLength(1);

    clock.advance(599_999);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p3_y', 20_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 0 } });
    expect(gatewayCalls).toHaveLength(1);
    expect((await cancelRows(p.paymentId)).map((r) => r.idempotency_key)).toEqual(['cancel-p3_x']);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });

    clock.advance(1);
    await expect(cancel(p.paymentId, 'p3_y', 20_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 20_000 } });
    expect(gatewayCalls).toHaveLength(2);
    // 10분 지난 진행 중 건(x)이 있으니 금액으로 보내고, 기대 잔액은 결제 금액 − 누적(0)이다
    expect(gatewayCalls[1]).toEqual(body(p.orderId, 'p3_y', 20_000, PRICE));
    expect((await cancelRows(p.paymentId)).find((r) => r.idempotency_key === 'cancel-p3_y')).toMatchObject({ full_cancel: false, expected_balance: PRICE, status: 'CANCELED' });

    // 앞 취소(x)를 같은 ID로 다시 부르면 저장한 첫 본문을 보낸다
    await expect(cancel(p.paymentId, 'p3_x', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(gatewayCalls[2]).toEqual(gatewayCalls[0]);
    // 둘 다 반영된 뒤의 새 취소는 새 잔액(100,000 − 50,000)을 기대 잔액으로 보낸다
    await expect(cancel(p.paymentId, 'p3_z', 10_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 60_000 } });
    expect(gatewayCalls[3]).toEqual(body(p.orderId, 'p3_z', 10_000, 50_000));
  });

  test('GAT-080 P3 진행 중 CANCEL_PENDING 건도 10분 안이면 막고, 거절로 FAILED가 된 건은 막지 않는다', async () => {
    const pending = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'CANCEL_PENDING';
    await expect(cancel(pending.paymentId, 'p3_pending', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCEL_PENDING' });
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(pending.paymentId, 'p3_after_pending', 10_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 0 } });
    expect(gatewayCalls).toHaveLength(1);
    expect((await cancelRows(pending.paymentId)).map((r) => [r.idempotency_key, r.status])).toEqual([['cancel-p3_pending', 'CANCEL_PENDING']]);

    const failed = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'REJECTED';
    await expect(cancel(failed.paymentId, 'p3_failed', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED' });
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(failed.paymentId, 'p3_after_failed', 10_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 10_000 } });
    expect(gatewayCalls).toHaveLength(3);
    expect(gatewayCalls[2]).toEqual(body(failed.orderId, 'p3_after_failed', 10_000, PRICE));
  });

  test('GAT-080 P4 끝남은 그 취소 건의 상태로만 가른다: 거절된 X는 다른 취소 Y가 원장을 PARTIAL_CANCELED로 만든 뒤 다시 불러도 CANCELLED가 아니라 결제사 없이 REJECTED다(리뷰 B3)', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'REJECTED';
    await expect(cancel(p.paymentId, 'p4_x', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED' });
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p4_y', 20_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 20_000 } });
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 20_000 });

    await expect(cancel(p.paymentId, 'p4_x', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED', cancelled_amount: { krw: 20_000 } });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[0]).toEqual(body(p.orderId, 'p4_x', 30_000, PRICE));
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 20_000 });
    expect((await cancelRows(p.paymentId)).map((r) => [r.idempotency_key, r.status])).toEqual([
      ['cancel-p4_x', 'FAILED'],
      ['cancel-p4_y', 'CANCELED'],
    ]);
  });

  test('GAT-080 P5 같은 취소의 겹친 재시도 둘이 모두 결제사 성공을 받아도 누적액은 30,000 한 번만 는다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'CANCELLED';
    holdUntil(2);
    const [a, b] = await Promise.all([cancel(p.paymentId, 'p5', 30_000), cancel(p.paymentId, 'p5', 30_000)]);
    barrier = undefined;
    // 장애 주입이 실제로 있었다: 두 호출이 모두 결제사에 닿았다
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[1]).toEqual(gatewayCalls[0]);
    expect(a).toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 30_000 } });
    expect(b).toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 30_000 } });
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 30_000 });
    expect(await cancelRows(p.paymentId)).toEqual([{ idempotency_key: 'cancel-p5', amount: 30_000, reason: '관객 취소', full_cancel: false, expected_balance: PRICE, status: 'CANCELED' }]);
  });

  test('GAT-080 P7 결제 100,000·누적 20,000·진행 중 다른 건 30,000에서 50,001은 INVALID_ARGUMENT, 딱 맞는 50,000은 받고, 같은 ID의 다른 금액은 INVALID_ARGUMENT다', async () => {
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p7_other', 30_000);
    clock.advance(600_000); // 10분 지나 BUSY로 막히지 않게 한다(진행 중 합 검사만 본다)
    gatewayCalls = [];
    gatewayOutcome = 'CANCELLED';
    expect((await failure(cancel(p.paymentId, 'p7_over', 50_001))).code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(gatewayCalls).toHaveLength(0);
    expect((await cancelRows(p.paymentId)).map((r) => r.idempotency_key)).toEqual(['cancel-p7_other']);
    await expect(cancel(p.paymentId, 'p7_fit', 50_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 70_000 } });
    expect(gatewayCalls).toEqual([body(p.orderId, 'p7_fit', 50_000, 80_000)]);

    const q = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayCalls = [];
    gatewayOutcome = 'UNKNOWN';
    await cancel(q.paymentId, 'p7_same', 30_000);
    expect((await failure(cancel(q.paymentId, 'p7_same', 31_000))).code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(gatewayCalls).toHaveLength(1);
    expect(await cancelRows(q.paymentId)).toEqual([{ idempotency_key: 'cancel-p7_same', amount: 30_000, reason: '관객 취소', full_cancel: false, expected_balance: PRICE, status: 'REQUESTED' }]);
  });

  test('GAT-080 P8 0021 payment_cancel은 결제·멱등키 유일과 금액·기대 잔액·상태 검사·외래키·진행 중 색인을 건다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    const put = (o: { key: string; amount?: number; expected?: number; status?: string; paymentId?: string }) =>
      admin.pool.query(
        `insert into payment_cancel (id, payment_id, idempotency_key, amount, reason, full_cancel, expected_balance, status, created_at)
         values ($1, $2, $3, $4, '관객 취소', false, $5, $6, now())`,
        [newId(), o.paymentId ?? p.paymentId, o.key, o.amount ?? 1_000, o.expected ?? 1_000, o.status ?? 'REQUESTED'],
      );
    await put({ key: 'cancel-p8' });
    await expect(put({ key: 'cancel-p8' })).rejects.toMatchObject({ code: '23505' });
    await expect(put({ key: 'cancel-p8_zero', amount: 0, expected: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(put({ key: 'cancel-p8_low', amount: 1_000, expected: 999 })).rejects.toMatchObject({ code: '23514' });
    await expect(put({ key: 'cancel-p8_bad', status: 'DONE' })).rejects.toMatchObject({ code: '23514' });
    for (const status of ['CANCEL_PENDING', 'CANCELED', 'FAILED']) await put({ key: `cancel-p8_${status}`, status });
    await expect(put({ key: 'cancel-p8_fk', paymentId: newId() })).rejects.toMatchObject({ code: '23503' });
    // 같은 멱등키라도 다른 결제면 들어간다
    const other = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    await put({ key: 'cancel-p8', paymentId: other.paymentId });
    const idx = await admin.pool.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and tablename = 'payment_cancel'");
    expect(idx.rows.some((r) => r.indexdef.includes('(payment_id)') && r.indexdef.includes('REQUESTED') && r.indexdef.includes('CANCEL_PENDING'))).toBe(true);
  });

  test('GAT-080 P9 거절은 행을 FAILED, 비동기 처리는 CANCEL_PENDING으로 두고 원장은 그대로다', async () => {
    const r = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'REJECTED';
    await expect(cancel(r.paymentId, 'p9_rejected', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED', cancelled_amount: { krw: 0 } });
    expect(await rowOf(r.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect((await cancelRows(r.paymentId)).map((x) => x.status)).toEqual(['FAILED']);

    const c = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'CANCEL_PENDING';
    await expect(cancel(c.paymentId, 'p9_pending', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCEL_PENDING', cancelled_amount: { krw: 0 } });
    expect(await rowOf(c.paymentId)).toEqual({ status: 'APPROVED', cancelled_amount: 0 });
    expect((await cancelRows(c.paymentId)).map((x) => x.status)).toEqual(['CANCEL_PENDING']);
  });
});

describe('P-T21 3시간 지난 재시도의 조회 대조(실제 저장소)', () => {
  const found = (orderId: string, balanceAmount: number): QueryResult => ({ kind: 'FOUND', paymentRef: `ref-${orderId}`, orderRef: orderId, status: 'PARTIAL_CANCELED', amount: PRICE, balanceAmount });

  test('P-T21 3시간 지난 재시도는 먼저 조회해 이미 반영된 취소(잔액 50,000 = 80,000 − 30,000)를 다시 보내지 않고 원장에 한 번 반영한다', async () => {
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'pt21_applied', 30_000);
    expect(gatewayCalls).toEqual([body(p.orderId, 'pt21_applied', 30_000, 80_000)]);
    clock.advance(10_800_000);
    queryAnswer = found(p.orderId, 50_000);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'pt21_applied', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(queryCalls).toEqual([`ref-${p.orderId}`]);
    expect(gatewayCalls).toHaveLength(1);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 50_000 });
    expect((await cancelRows(p.paymentId)).map((r) => r.status)).toEqual(['CANCELED']);
    // 끝난 건의 재요청은 조회도 결제사도 다시 부르지 않는다
    await expect(cancel(p.paymentId, 'pt21_applied', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(queryCalls).toHaveLength(1);
    expect(gatewayCalls).toHaveLength(1);
  });

  test('P-T21 3시간 지난 재시도에서 잔액이 그대로(80,000)면 같은 본문으로 한 번 다시 보내고, 70,000·조회 모름·기록 없음이면 보내지 않는다', async () => {
    const same = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(same.paymentId, 'pt21_same', 30_000);
    clock.advance(10_800_000);
    queryAnswer = found(same.orderId, 80_000);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(same.paymentId, 'pt21_same', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[1]).toEqual(gatewayCalls[0]);

    const cases: [string, (orderId: string) => QueryResult][] = [
      ['other', (orderId) => found(orderId, 70_000)],
      ['unknown', () => ({ kind: 'UNKNOWN' })],
      ['not_found', () => ({ kind: 'NOT_FOUND' })],
    ];
    for (const [name, answer] of cases) {
      const p = await partial();
      gatewayCalls = [];
      gatewayOutcome = 'UNKNOWN';
      await cancel(p.paymentId, `pt21_${name}`, 30_000);
      clock.advance(10_800_000);
      queryAnswer = answer(p.orderId);
      gatewayOutcome = 'CANCELLED';
      await expect(cancel(p.paymentId, `pt21_${name}`, 30_000), name).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 20_000 } });
      expect(gatewayCalls, name).toHaveLength(1);
      expect(await rowOf(p.paymentId), name).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 20_000 });
      expect((await cancelRows(p.paymentId)).map((r) => r.status), name).toEqual(['REQUESTED']);
    }
  });

  test('P-T21 3시간 직전(10,799,999ms)의 재시도는 조회하지 않고 같은 멱등키로 다시 보낸다', async () => {
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'pt21_edge', 30_000);
    clock.advance(10_799_999);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'pt21_edge', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED' });
    expect(queryCalls).toHaveLength(0);
    expect(gatewayCalls).toHaveLength(2);
    expect(gatewayCalls[1]).toEqual(gatewayCalls[0]);
  });
});

describe('GAT-080 P10 금액을 비운 요청과 진행 중인 다른 취소(BAT-415 계획 §10 ①, 실제 저장소)', () => {
  test('GAT-080 P10 금액을 비운 요청은 10분 지난 진행 중 취소를 빼고 금액을 적어 보내며 0 이하면 FAILED_PRECONDITION이다', async () => {
    // 결제 100,000·누적 20,000·같은 결제의 진행 중 다른 건 30,000(10분 지남) → 금액 비움은 50,000을 적어 보낸다
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p10_other', 30_000);
    clock.advance(600_000);
    gatewayCalls = [];
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p10_omit')).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 70_000 } });
    expect(gatewayCalls).toEqual([body(p.orderId, 'p10_omit', 50_000, 80_000)]);
    expect((await cancelRows(p.paymentId)).find((r) => r.idempotency_key === 'cancel-p10_omit')).toEqual({
      idempotency_key: 'cancel-p10_omit',
      amount: 50_000,
      reason: '관객 취소',
      full_cancel: false,
      expected_balance: 80_000,
      status: 'CANCELED',
    });
  });

  test('GAT-080 P10 진행 중 다른 건이 10분 안(599,999ms)이면 금액을 비운 요청도 결과 모름이 먼저다(결제사 0, 새 행 0)', async () => {
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p10_busy_other', 30_000);
    clock.advance(599_999);
    gatewayCalls = [];
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p10_busy_omit')).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 20_000 } });
    expect(gatewayCalls).toHaveLength(0);
    expect((await cancelRows(p.paymentId)).map((r) => r.idempotency_key)).toEqual(['cancel-p10_busy_other']);
  });

  test('GAT-080 P10 진행 중 다른 건이 남은 전부(80,000, 10분 지남)면 금액을 비운 요청은 FAILED_PRECONDITION이고 결제사·새 행이 없다', async () => {
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p10_all_other', 80_000);
    clock.advance(600_000);
    gatewayCalls = [];
    gatewayOutcome = 'CANCELLED';
    expect((await failure(cancel(p.paymentId, 'p10_zero'))).code).toBe(grpc.status.FAILED_PRECONDITION);
    expect(gatewayCalls).toHaveLength(0);
    expect((await cancelRows(p.paymentId)).map((r) => r.idempotency_key)).toEqual(['cancel-p10_all_other']);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 20_000 });
  });
});

// ---- BAT-415 리뷰 반영 B1·B3(계획 §11, docs/features/payment.md §4.1 '잔액으로 가르는 조건'·'같은 취소 ID의 재요청 세부' ③) ----
describe('GAT-080 리뷰 반영 B1·B3 [실제 저장소]', () => {
  const createdAtOf = async (paymentId: string, key: string): Promise<number> =>
    ((await admin.pool.query('select created_at from payment_cancel where payment_id = $1 and idempotency_key = $2', [paymentId, key])).rows[0].created_at as Date).getTime();
  const found = (orderId: string, balanceAmount: number): QueryResult => ({ kind: 'FOUND', paymentRef: `ref-${orderId}`, orderRef: orderId, status: 'PARTIAL_CANCELED', amount: PRICE, balanceAmount });

  test('GAT-080 P11 3시간 지난 재시도는 다른 취소가 반영된 뒤라면 잔액이 맞아도 반영으로 보지 않는다', async () => {
    // 결제 100,000·누적 20,000. X(30,000, 기대 잔액 80,000)가 결과 모름으로 남은 동안, 10분 넘어 같은 결제의 Z(30,000)가 나가 반영된다(누적 50,000)
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p11_x', 30_000);
    clock.advance(600_000);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p11_z', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(gatewayCalls).toHaveLength(2);
    // X를 만든 지 3시간(10,800,000ms)이 되도록 시계를 돌린다. 결제사 잔액 50,000은 X의 '기대 잔액 − 금액'과 우연히 같다
    clock.advance(10_800_000 - 600_000);
    queryAnswer = found(p.orderId, 50_000);
    await expect(cancel(p.paymentId, 'p11_x', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 50_000 } });
    expect(queryCalls).toEqual([`ref-${p.orderId}`]);
    expect(gatewayCalls).toHaveLength(2);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 50_000 });
    expect((await cancelRows(p.paymentId)).map((r) => [r.idempotency_key, r.status])).toEqual([
      ['cancel-p11_x', 'REQUESTED'],
      ['cancel-p11_z', 'CANCELED'],
    ]);
  });

  test('GAT-080 P11 3시간 지난 재시도는 같은 결제에 다른 진행 중 행이 있으면 가르지 않는다(대조: 그 행이 없으면 CANCELLED)', async () => {
    // 원장 그대로(누적 20,000)인데 다른 진행 중 행 W(30,000, 10분 넘음)가 있다
    const p = await partial();
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p11_w', 30_000);
    clock.advance(600_000);
    await cancel(p.paymentId, 'p11_x2', 30_000);
    expect(gatewayCalls).toHaveLength(2);
    clock.advance(10_800_000);
    queryAnswer = found(p.orderId, 50_000);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p11_x2', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_UNKNOWN', cancelled_amount: { krw: 20_000 } });
    expect(gatewayCalls).toHaveLength(2);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 20_000 });
    expect((await cancelRows(p.paymentId)).map((r) => r.status)).toEqual(['REQUESTED', 'REQUESTED']);

    // 대조: 다른 진행 중 행이 없으면 같은 입력(잔액 50,000)이 이 취소의 반영이다
    const q = await partial();
    gatewayCalls = [];
    gatewayOutcome = 'UNKNOWN';
    await cancel(q.paymentId, 'p11_alone', 30_000);
    clock.advance(10_800_000);
    queryAnswer = found(q.orderId, 50_000);
    await expect(cancel(q.paymentId, 'p11_alone', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 50_000 } });
    expect(gatewayCalls).toHaveLength(1);
  });

  test('GAT-080 P12 거절된 취소를 같은 취소 ID로 다시 부르면 결제사를 부르지 않고 REJECTED이고 행을 되살리지 않는다', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'REJECTED';
    await expect(cancel(p.paymentId, 'p12_x', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED' });
    const createdAt = await createdAtOf(p.paymentId, 'cancel-p12_x');
    clock.advance(1_000);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p12_x', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED', cancelled_amount: { krw: 0 } });
    expect(gatewayCalls).toHaveLength(1);
    expect((await cancelRows(p.paymentId)).map((r) => [r.idempotency_key, r.status])).toEqual([['cancel-p12_x', 'FAILED']]);
    expect(await createdAtOf(p.paymentId, 'cancel-p12_x')).toBe(createdAt);
    // 그 직후 같은 결제의 Y는 BUSY 없이 바로 보낸다(FAILED는 진행 중이 아니다)
    await expect(cancel(p.paymentId, 'p12_y', 10_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 10_000 } });
    expect(gatewayCalls).toHaveLength(2);
    expect(await rowOf(p.paymentId)).toEqual({ status: 'PARTIAL_CANCELED', cancelled_amount: 10_000 });
  });

  test('GAT-080 P12 10분 안의 다른 진행 중 행이 있어도 거절된 취소의 재요청은 BUSY(UNKNOWN)가 아니라 REJECTED다(차례: FAILED가 BUSY보다 먼저)', async () => {
    const p = await putPayment(admin, { status: 'APPROVED', amount: PRICE });
    gatewayOutcome = 'REJECTED';
    await cancel(p.paymentId, 'p12_rx', 30_000);
    gatewayOutcome = 'UNKNOWN';
    await cancel(p.paymentId, 'p12_v', 20_000);
    expect(gatewayCalls).toHaveLength(2);
    clock.advance(1_000);
    gatewayOutcome = 'CANCELLED';
    await expect(cancel(p.paymentId, 'p12_rx', 30_000)).resolves.toMatchObject({ result: 'CANCEL_RESULT_REJECTED', cancelled_amount: { krw: 0 } });
    expect(gatewayCalls).toHaveLength(2);
    expect((await cancelRows(p.paymentId)).map((r) => [r.idempotency_key, r.status])).toEqual([
      ['cancel-p12_rx', 'FAILED'],
      ['cancel-p12_v', 'REQUESTED'],
    ]);
  });
});
