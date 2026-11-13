// 결제 후 일반 취소(GAT-080, docs/features/payment.md §4.1)를 실제 PostgreSQL 18과 실제 gRPC 서버로 돈다.
// 부분·전액 취소, 같은 취소 ID 재요청, 결제사 CANCEL_PENDING·UNKNOWN의 원장 무변경, cancelled_amount 누적·CHECK를 본다.
// 결제사만 기록 대역이다(멱등키 cancel-{cancellationId}와 금액을 본다).
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
import type { CancelResult, PaymentGatewayPort } from '../src/modules/payment/domain/payment-gateway.js';
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
      return { outcome: gatewayOutcome };
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
  await admin.pool.query('truncate payment, payment_event, payment_confirm_job');
  gatewayOutcome = 'CANCELLED';
  gatewayCalls = [];
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
