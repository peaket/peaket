// 입금 전 취소만 부르기(범위 DEPOSIT_ONLY, docs/features/payment.md §6 '입금 전 취소만 부르기'·§4.1 '탈퇴 참여자의 첫 구현' '입금 대기 취소'·§11 P-T55 ④,
// docs/api/proto/peaket/payment/v1/payment.proto CancelScope, BAT-010 시험 결과 판정 D1·D2, BAT-010 시험 담당). DB 없이 돈다.
// 운영 처리기를 그대로 잇는다: 받는 층(paymentServiceHandlers·cancelInputOf) → 갈래 고르기(CancelPayment) → 입금 전 취소(CancelDepositPayment)·결제 후 일반 취소(CancelConfirmedPayment).
// 저장소는 원장 한 줄을 담은 대역이다. 입금 전 취소 시작의 규칙(그 취소 ID로 FAILED면 DONE, 입금 대기가 아니면 NOT_WAITING, 아니면 표시를 쓰고 BEGUN)은 정본 §6 '입금 전 취소'대로 두었다.
// 일반 취소 저장소는 부르면 적고 던지는 대역이다(범위 DEPOSIT_ONLY에서 한 번도 불리면 안 된다). 실제 PostgreSQL은 purchase test-int/withdrawal-participant.int.test.ts가 본다.
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import type { PaymentLedgerStatus } from '../src/modules/payment/domain/confirm-command.js';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import {
  CancelConfirmedPayment,
  CancelDepositPayment,
  cancelInputOf,
  CancelPayment,
  type DepositCancelBegin,
  type DepositCancelTarget,
  PaymentInputError,
  paymentPackage,
  paymentServiceHandlers,
} from '../src/modules/payment/server.js';

const NOW = Date.parse('2026-11-18T10:20:31.000Z');
const ORDER = '0193a000-0000-7000-8000-0000000055d1';
const PAYMENT = '0193a000-0000-7000-8000-0000000055d2';
const EVENT = '0193a000-0000-7000-8000-0000000055d3';
const AMOUNT = 88_000;
/** 탈퇴 참여자의 취소 ID(withdrawal-{주문 ID}, payment §4.1) */
const CANCELLATION = `withdrawal-${ORDER}`;
const REASON = 'ACCOUNT_WITHDRAWAL';
const TARGET: DepositCancelTarget = { paymentId: PAYMENT, orderId: ORDER, eventId: EVENT, attemptNo: 1, pg: 'TOSS', paymentRef: 'tgen_withdrawal_1', amount: AMOUNT };

interface Ledger {
  status: PaymentLedgerStatus;
  /** 이 원장에 남은 입금 전 취소 표시(DEPOSIT_CANCEL_SENT)의 취소 ID들 */
  sent: string[];
}

/** 원장 한 줄과 결제사·일반 취소 저장소 대역으로 운영 처리기를 잇는다 */
function world(start: Ledger) {
  const ledger: Ledger = { status: start.status, sent: [...start.sent] };
  const calls: string[] = [];
  const gatewayCalls: string[] = [];
  const confirmedCalls: string[] = [];
  const outcomes: string[] = [];
  const clock = fakeClock({ now: NOW });
  const gateway = {
    pg: 'TOSS',
    cancel: async (c: Parameters<PaymentGatewayPort['cancel']>[0]): Promise<CancelResult> => {
      gatewayCalls.push(`cancel:${c.idemKey}`);
      return { outcome: 'CANCELLED' } as CancelResult;
    },
    query: async (): Promise<QueryResult> => {
      gatewayCalls.push('query');
      return { kind: 'FOUND', paymentRef: TARGET.paymentRef, orderRef: ORDER, status: 'CANCELED', amount: AMOUNT, balanceAmount: AMOUNT } as QueryResult;
    },
  } as unknown as PaymentGatewayPort;
  const depositStore = {
    readCancelTarget: async () => {
      calls.push('readCancelTarget');
      return TARGET;
    },
    readCancelStatus: async () => {
      calls.push('readCancelStatus');
      return ledger.status;
    },
    beginDepositCancel: async (_t: DepositCancelTarget, cancellationId: string): Promise<DepositCancelBegin> => {
      calls.push('beginDepositCancel');
      if (ledger.status === 'FAILED' && ledger.sent.includes(cancellationId)) return 'DONE';
      if (ledger.status !== 'AWAITING_DEPOSIT') return 'NOT_WAITING';
      if (!ledger.sent.includes(cancellationId)) ledger.sent.push(cancellationId);
      return 'BEGUN';
    },
    finishDepositCancel: async () => {
      calls.push('finishDepositCancel');
      if (ledger.status !== 'AWAITING_DEPOSIT') return 'STALE' as const;
      ledger.status = 'FAILED';
      return 'APPLIED' as const;
    },
  };
  // 일반 취소 저장소: 어떤 메서드든 부르면 적고 던진다
  const confirmedStore = new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'then' ? undefined : async () => {
        confirmedCalls.push(String(prop));
        throw new Error(`일반 취소 저장소를 불렀다: ${String(prop)}`);
      }),
    },
  );
  const guards = { of: () => ({ tryTakeToken: () => true, circuitClosed: () => true, admitsQuery: () => true, run: <T>(action: () => Promise<T>) => action() }) } as never;
  const gateways = { of: () => gateway } as never;
  const router = new CancelPayment(
    new CancelDepositPayment({ store: depositStore as never, gateways, guards, signals: { cancel: (x: string) => void outcomes.push(x) } as never, clock }),
    new CancelConfirmedPayment({ store: confirmedStore as never, gateways, guards, clock }),
    depositStore as never,
  );
  return { ledger, calls, gatewayCalls, confirmedCalls, outcomes, router };
}

const INPUT = { paymentId: PAYMENT, cancellationId: CANCELLATION, reason: REASON, amount: AMOUNT };
const DEPOSIT_ONLY = { ...INPUT, scope: 'DEPOSIT_ONLY' } as never as Parameters<CancelPayment['execute']>[0];

describe('범위 DEPOSIT_ONLY: 입금 대기가 아니면 REJECTED(P-T55 ④, BAT-010 D1)', () => {
  test.each<[string, Ledger]>([
    ['승인(APPROVED: 입금이 먼저 확정됨)', { status: 'APPROVED', sent: [] }],
    ['부분 취소(PARTIAL_CANCELED)', { status: 'PARTIAL_CANCELED', sent: [] }],
    ['표시 없는 FAILED(기한 경과 등 다른 길로 끝남)', { status: 'FAILED', sent: [] }],
    ['다른 취소 ID의 표시만 있는 FAILED', { status: 'FAILED', sent: ['evt-cancel_other01'] }],
  ])('P-T55④_DEPOSIT_ONLY에 원장이 %s면 REJECTED이고 결제사를 부르지 않으며 원장·표시가 그대로이고 일반 취소로 가지 않는다 [ASVS v5.0.0-2.3.1]', async (_name, start) => {
    const w = world(start);
    await expect(w.router.execute(DEPOSIT_ONLY)).resolves.toEqual({ result: 'REJECTED' });
    expect(w.gatewayCalls).toEqual([]);
    expect(w.confirmedCalls).toEqual([]);
    expect(w.ledger).toEqual({ status: start.status, sent: start.sent });
    expect(w.calls).not.toContain('finishDepositCancel');
    // 원장을 미리 읽어 갈래를 고르지 않는다(입금 대기 확인은 입금 전 취소의 시작이 한다)
    expect(w.calls).not.toContain('readCancelStatus');
    expect(w.outcomes).toEqual(['rejected']);
  });
});

describe('범위 DEPOSIT_ONLY: 그 취소 ID로 이미 끝났으면 CANCELLED(P-T55 ④, BAT-010 D2)', () => {
  test('P-T55④_DEPOSIT_ONLY에 그 취소 ID로 끝난(FAILED·표시 있음) 원장이면 결제사를 다시 부르지 않고 CANCELLED다', async () => {
    const w = world({ status: 'FAILED', sent: [CANCELLATION] });
    await expect(w.router.execute(DEPOSIT_ONLY)).resolves.toEqual({ result: 'CANCELLED' });
    expect(w.gatewayCalls).toEqual([]);
    expect(w.confirmedCalls).toEqual([]);
    expect(w.ledger).toEqual({ status: 'FAILED', sent: [CANCELLATION] });
  });

  test('P-T55④_DEPOSIT_ONLY에 입금 대기 원장이면 입금 전 취소를 하고(멱등키 cancel-{취소 ID}) 같은 취소 ID로 다시 부르면 결제사를 다시 부르지 않고 CANCELLED다', async () => {
    const w = world({ status: 'AWAITING_DEPOSIT', sent: [] });
    await expect(w.router.execute(DEPOSIT_ONLY)).resolves.toEqual({ result: 'CANCELLED' });
    expect(w.gatewayCalls).toEqual([`cancel:cancel-${CANCELLATION}`, 'query']);
    expect(w.ledger).toEqual({ status: 'FAILED', sent: [CANCELLATION] });
    await expect(w.router.execute(DEPOSIT_ONLY)).resolves.toEqual({ result: 'CANCELLED' });
    expect(w.gatewayCalls).toEqual([`cancel:cancel-${CANCELLATION}`, 'query']);
    expect(w.confirmedCalls).toEqual([]);
  });
});

describe('모르는 범위와 범위를 비운 요청(P-T55 ④)', () => {
  test.each(['EVERYTHING', 'deposit_only', '7'])('P-T55④_모르는 범위 값 %s는 INVALID_ARGUMENT(scope)이고 원장·결제사를 부르지 않는다 [ASVS v5.0.0-2.2.1]', async (scope) => {
    const w = world({ status: 'AWAITING_DEPOSIT', sent: [] });
    const e = await w.router.execute({ ...INPUT, scope } as never).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PaymentInputError);
    expect((e as PaymentInputError).field).toBe('scope');
    expect(w.calls).toEqual([]);
    expect(w.gatewayCalls).toEqual([]);
  });

  test('P-T55④_범위를 비우면 지금 그대로다: 승인 원장은 원장 상태로 골라 결제 후 일반 취소로 간다(GAT-080)', async () => {
    const w = world({ status: 'APPROVED', sent: [] });
    await w.router.execute(INPUT).catch(() => undefined);
    expect(w.calls).toEqual(['readCancelStatus']);
    expect(w.confirmedCalls.length).toBeGreaterThan(0);
  });

  test('P-T55④_받는 층의 범위 칸: CANCEL_SCOPE_DEPOSIT_ONLY는 DEPOSIT_ONLY이고, 비었거나 CANCEL_SCOPE_UNSPECIFIED(0)면 칸이 없다', () => {
    const base = { payment_id: PAYMENT, cancellation_id: CANCELLATION, reason: REASON, amount: { krw: AMOUNT } };
    expect(cancelInputOf({ ...base, scope: 'CANCEL_SCOPE_DEPOSIT_ONLY' })).toEqual({ ...INPUT, scope: 'DEPOSIT_ONLY' });
    for (const scope of [undefined, 'CANCEL_SCOPE_UNSPECIFIED', 0]) {
      const got = cancelInputOf(scope === undefined ? base : { ...base, scope });
      expect(got).toEqual(INPUT);
      expect(got).not.toHaveProperty('scope');
    }
  });
});

describe('gRPC CancelPayment의 범위 칸(선 위의 값, P-T55 ④)', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });
  type Cb = (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void;
  type Client = grpc.Client & { CancelPayment(req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb): void };
  async function serve(w: ReturnType<typeof world>) {
    const handlers = paymentServiceHandlers(
      {
        accept: { execute: async () => Promise.reject(new Error('부르지 않는다')) } as never,
        batchGet: { execute: async () => Promise.reject(new Error('부르지 않는다')) } as never,
        cancelPayment: w.router,
      },
      () => {},
    );
    const server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
    const client = new (paymentPackage().PaymentService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
    closers.push(async () => {
      client.close();
      await server.close();
    });
    return (req: object) => new Promise<Record<string, unknown>>((res, rej) => client.CancelPayment(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  }
  const req = (scope?: unknown) => ({ payment_id: PAYMENT, cancellation_id: CANCELLATION, reason: REASON, amount: { krw: AMOUNT }, ...(scope === undefined ? {} : { scope }) });

  test('P-T55④_CANCEL_SCOPE_DEPOSIT_ONLY에 승인 원장이면 오류가 아니라 CANCEL_RESULT_REJECTED이고 결제사·일반 취소를 부르지 않는다', async () => {
    const w = world({ status: 'APPROVED', sent: [] });
    const call = await serve(w);
    expect(await call(req('CANCEL_SCOPE_DEPOSIT_ONLY'))).toMatchObject({ result: 'CANCEL_RESULT_REJECTED' });
    expect(w.gatewayCalls).toEqual([]);
    expect(w.confirmedCalls).toEqual([]);
    expect(w.ledger.status).toBe('APPROVED');
  });

  test('P-T55④_모르는 범위 값(열거 밖 숫자 7)은 INVALID_ARGUMENT이고 원장을 읽지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const w = world({ status: 'AWAITING_DEPOSIT', sent: [] });
    const call = await serve(w);
    const e = await call(req(7)).catch((x: grpc.ServiceError) => x);
    expect(grpc.status[(e as grpc.ServiceError).code]).toBe('INVALID_ARGUMENT');
    expect(w.calls).toEqual([]);
    expect(w.gatewayCalls).toEqual([]);
  });

  test('P-T55④_범위를 비운 요청은 지금 그대로다: 입금 대기 원장은 입금 전 취소로 CANCEL_RESULT_CANCELLED', async () => {
    const w = world({ status: 'AWAITING_DEPOSIT', sent: [] });
    const call = await serve(w);
    expect(await call(req())).toMatchObject({ result: 'CANCEL_RESULT_CANCELLED' });
    expect(w.calls[0]).toBe('readCancelStatus');
    expect(w.gatewayCalls).toEqual([`cancel:cancel-${CANCELLATION}`, 'query']);
  });
});
