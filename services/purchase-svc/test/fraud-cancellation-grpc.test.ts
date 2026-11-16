// gRPC FraudCancellationService 처리기(fraud_cancellation.proto, docs/features/transfer-refund.md §7.4 '호출자', BUILD_ORDER GAT-080, BAT-415 몫 F).
// 실제 grpc-js 서버(startPurchaseGrpcServer, 운영과 같은 내부 토큰 인터셉터)에 처리기를 올리고, 클라이언트는 계약 설명자(@peaket/contracts/proto)에서 따로 만든다.
// 쓰임새는 기록 가짜다. 부르는 쪽 검사(호출자 ops-svc + 처리자 approved_by 증명), 오류 매핑, 답의 칸 이름·enum 이름을 본다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Fraudcancellation } from '@peaket/contracts/proto';
import { INTERNAL_GRPC_ACTOR_HEADER, INTERNAL_GRPC_ACTOR_PROOF_HEADER, INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, internalGrpcActorProof } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPurchaseGrpcServer } from '../src/grpc-server.js';
import { type CancelFraudTicketsInput, FraudCancellationError, type FraudRefundProgress, type FraudTicketResult, fraudCancellationHandlers } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-16T01:00:00.000Z');
const TOKEN = 'internal-grpc-token-for-test';
const APPROVED_BY = 'commander-2';
const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Reply = Record<string, unknown>;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Reply) => void) => grpc.ClientUnaryCall;
type Client = grpc.Client & { CancelFraudTickets: Unary; GetFraudCancellation: Unary };

const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(purchaseV1Fraudcancellation as Parameters<typeof protoLoader.fromJSON>[0], LOAD)) as unknown as {
  peaket: { purchase: { v1: { FraudCancellationService: grpc.ServiceClientConstructor } } };
}).peaket.purchase.v1;

const cancelCalls: CancelFraudTicketsInput[] = [];
const getCalls: string[] = [];
let cancelAnswer: () => Promise<readonly FraudTicketResult[]> = async () => [];
let getAnswer: () => Promise<{ results: readonly FraudTicketResult[]; refunds: readonly FraudRefundProgress[] }> = async () => ({ results: [], refunds: [] });
const errors: string[] = [];
const useCases = {
  cancel: {
    execute: async (i: CancelFraudTicketsInput) => {
      cancelCalls.push(i);
      return cancelAnswer();
    },
  },
  get: {
    execute: async (approvalId: string) => {
      getCalls.push(approvalId);
      return getAnswer();
    },
  },
  nowMs: () => NOW,
};

let guarded: { port: number; close(): Promise<void> };
let open: { port: number; close(): Promise<void> };
let client: Client;
let openClient: Client;

beforeAll(async () => {
  guarded = await startPurchaseGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: pkg.FraudCancellationService.service, handlers: fraudCancellationHandlers(useCases, { internalToken: TOKEN, onError: (m, e) => errors.push(`${m}:${String(e)}`) }) }],
    internal: { token: TOKEN, services: ['peaket.purchase.v1.FraudCancellationService'] },
  });
  open = await startPurchaseGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: pkg.FraudCancellationService.service, handlers: fraudCancellationHandlers(useCases) }] });
  client = new pkg.FraudCancellationService(`127.0.0.1:${guarded.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  openClient = new pkg.FraudCancellationService(`127.0.0.1:${open.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});
afterAll(async () => {
  client?.close();
  openClient?.close();
  await guarded?.close();
  await open?.close();
});
beforeEach(() => {
  cancelCalls.length = 0;
  getCalls.length = 0;
  errors.length = 0;
  cancelAnswer = async () => [];
  getAnswer = async () => ({ results: [], refunds: [] });
});

const md = (o: { token?: string; caller?: string; actor?: string; proofFor?: string } = {}): grpc.Metadata => {
  const m = new grpc.Metadata();
  if (o.token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
  if (o.caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
  if (o.actor !== undefined) m.set(INTERNAL_GRPC_ACTOR_HEADER, o.actor);
  if (o.proofFor !== undefined) m.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof(TOKEN, o.proofFor));
  return m;
};
const ops = (): grpc.Metadata => md({ token: TOKEN, caller: 'ops-svc', actor: APPROVED_BY, proofFor: APPROVED_BY });
const unary = (c: Client, method: 'CancelFraudTickets' | 'GetFraudCancellation', req: object, meta: grpc.Metadata): Promise<Reply> =>
  new Promise((resolve, reject) => {
    c[method](req, meta, { deadline: new Date(Date.now() + 5_000) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
  });
const failure = async (p: Promise<unknown>): Promise<grpc.ServiceError> => {
  try {
    await p;
  } catch (e) {
    return e as grpc.ServiceError;
  }
  throw new Error('gRPC 오류를 기대했는데 성공했다');
};

const APPROVAL = randomUUID();
const FRAUD_CASE = randomUUID();
const EVENT = randomUUID();
const TICKET_A = randomUUID();
const TICKET_B = randomUUID();
const HOLDER = randomUUID();
const request = (approvedBy = APPROVED_BY) => ({
  approval_id: APPROVAL,
  fraud_case_id: FRAUD_CASE,
  event_id: EVENT,
  targets: [
    { ticket_id: TICKET_A, expected_holder_account_id: HOLDER },
    { ticket_id: TICKET_B, expected_holder_account_id: HOLDER },
  ],
  requested_by: 'investigator-1',
  approved_by: approvedBy,
  approved_at: { seconds: Math.floor((NOW - 60_000) / 1000), nanos: 0 },
});

describe('GAT-080 몫 F FraudCancellationService 부르는 쪽 검사', () => {
  test('GAT-080 F14 [ASVS v5.0.0-8.2.1] 부르는 쪽이 ops-svc가 아니면 PERMISSION_DENIED이고 쓰임새를 부르지 않는다', async () => {
    const asTrust = md({ token: TOKEN, caller: 'trust-svc', actor: APPROVED_BY, proofFor: APPROVED_BY });
    expect((await failure(unary(client, 'CancelFraudTickets', request(), asTrust))).code).toBe(grpc.status.PERMISSION_DENIED);
    expect((await failure(unary(client, 'GetFraudCancellation', { approval_id: APPROVAL }, md({ token: TOKEN, caller: 'trust-svc' })))).code).toBe(grpc.status.PERMISSION_DENIED);
    expect(cancelCalls).toHaveLength(0);
    expect(getCalls).toHaveLength(0);
  });

  test('GAT-080 F14 [ASVS v5.0.0-8.2.1] 처리자 증명이 approved_by의 것이 아니면(다른 사람의 증명·처리자 머리 다름·증명 없음) PERMISSION_DENIED다', async () => {
    const cases: [string, grpc.Metadata][] = [
      ['다른 사람의 증명', md({ token: TOKEN, caller: 'ops-svc', actor: APPROVED_BY, proofFor: 'commander-9' })],
      ['처리자 머리가 approved_by와 다름', md({ token: TOKEN, caller: 'ops-svc', actor: 'commander-9', proofFor: 'commander-9' })],
      ['증명 없음', md({ token: TOKEN, caller: 'ops-svc', actor: APPROVED_BY })],
    ];
    for (const [name, meta] of cases) {
      expect((await failure(unary(client, 'CancelFraudTickets', request(), meta))).code, name).toBe(grpc.status.PERMISSION_DENIED);
    }
    expect(cancelCalls).toHaveLength(0);
  });

  test('GAT-080 F14 [ASVS v5.0.0-8.2.1] 내부 토큰이 없으면 UNAUTHENTICATED이고, 토큰을 두지 않은 local·ci 조립은 지금처럼 받는다', async () => {
    expect((await failure(unary(client, 'CancelFraudTickets', request(), md({ caller: 'ops-svc', actor: APPROVED_BY })))).code).toBe(grpc.status.UNAUTHENTICATED);
    expect(cancelCalls).toHaveLength(0);
    await expect(unary(openClient, 'CancelFraudTickets', request(), new grpc.Metadata())).resolves.toMatchObject({ results: [] });
    expect(cancelCalls).toHaveLength(1);
  });

  test('GAT-080 F14 호출자·처리자가 맞으면 요청 칸을 쓰임새 입력으로 바꿔 넘기고 결과를 계약 이름으로 돌려준다', async () => {
    const cancellationId = randomUUID();
    cancelAnswer = async () => [
      { ticketId: TICKET_A, outcome: 'ACCEPTED', cancellationId, refundAmount: 33_333 },
      { ticketId: TICKET_B, outcome: 'FAILED', failureCode: 'SEAT_RETURN_FAILED' },
    ];
    const reply = await unary(client, 'CancelFraudTickets', request(), ops());
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]).toMatchObject({
      approvalId: APPROVAL,
      fraudCaseId: FRAUD_CASE,
      eventId: EVENT,
      targets: [
        { ticketId: TICKET_A, expectedHolderAccountId: HOLDER },
        { ticketId: TICKET_B, expectedHolderAccountId: HOLDER },
      ],
      requestedBy: 'investigator-1',
      approvedBy: APPROVED_BY,
      approvedAtMs: NOW - 60_000,
      nowMs: NOW,
    });
    const results = reply.results as Reply[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ticket_id: TICKET_A, outcome: 'FRAUD_CANCELLATION_OUTCOME_ACCEPTED', cancellation_id: cancellationId, refund_amount: { krw: 33_333 }, withdrawn_transfer_offer_id: '', failure_code: '' });
    expect(results[1]).toMatchObject({ ticket_id: TICKET_B, outcome: 'FRAUD_CANCELLATION_OUTCOME_FAILED', cancellation_id: '', failure_code: 'SEAT_RETURN_FAILED' });
  });

  test('GAT-080 F17 GetFraudCancellation 답은 결과와 환급 상태(FRAUD_REFUND_STATE_*)·환급 시각(Timestamp)이다', async () => {
    const cancellationId = randomUUID();
    const refundedAtMs = NOW + 3_600_123;
    getAnswer = async () => ({
      results: [{ ticketId: TICKET_A, outcome: 'ACCEPTED', cancellationId, refundAmount: 33_333 }],
      refunds: [
        { ticketId: TICKET_A, cancellationId, state: 'REFUNDED', refundedAtMs },
        { ticketId: TICKET_B, cancellationId: randomUUID(), state: 'NEEDS_CS' },
        { ticketId: randomUUID(), cancellationId: randomUUID(), state: 'PENDING' },
      ],
    });
    const reply = await unary(client, 'GetFraudCancellation', { approval_id: APPROVAL }, md({ token: TOKEN, caller: 'ops-svc' }));
    expect(getCalls).toEqual([APPROVAL]);
    expect((reply.results as Reply[])[0]).toMatchObject({ ticket_id: TICKET_A, outcome: 'FRAUD_CANCELLATION_OUTCOME_ACCEPTED', refund_amount: { krw: 33_333 } });
    const refunds = reply.refunds as Reply[];
    expect(refunds.map((r) => r.state)).toEqual(['FRAUD_REFUND_STATE_REFUNDED', 'FRAUD_REFUND_STATE_NEEDS_CS', 'FRAUD_REFUND_STATE_PENDING']);
    expect(refunds[0]).toMatchObject({ ticket_id: TICKET_A, cancellation_id: cancellationId, refunded_at: { seconds: Math.floor(refundedAtMs / 1000), nanos: 123_000_000 } });
  });

  test('GAT-080 F14 오류 매핑: INVALID·ALREADY_EXISTS·DEADLINE_PASSED·NOT_FOUND는 INVALID_ARGUMENT·ALREADY_EXISTS·FAILED_PRECONDITION·NOT_FOUND, 그 밖은 원문 없는 INTERNAL이다', async () => {
    const mapping: [FraudCancellationError['code'], grpc.status][] = [
      ['INVALID', grpc.status.INVALID_ARGUMENT],
      ['ALREADY_EXISTS', grpc.status.ALREADY_EXISTS],
      ['DEADLINE_PASSED', grpc.status.FAILED_PRECONDITION],
    ];
    for (const [code, status] of mapping) {
      cancelAnswer = async () => Promise.reject(new FraudCancellationError(code, `${code} 시험`));
      expect((await failure(unary(client, 'CancelFraudTickets', request(), ops()))).code, code).toBe(status);
    }
    getAnswer = async () => Promise.reject(new FraudCancellationError('NOT_FOUND', '없는 승인'));
    expect((await failure(unary(client, 'GetFraudCancellation', { approval_id: randomUUID() }, md({ token: TOKEN, caller: 'ops-svc' })))).code).toBe(grpc.status.NOT_FOUND);

    cancelAnswer = async () => Promise.reject(new Error('postgres password=hunter2 연결 실패'));
    const internal = await failure(unary(client, 'CancelFraudTickets', request(), ops()));
    expect(internal.code).toBe(grpc.status.INTERNAL);
    expect(internal.details).not.toContain('hunter2');
    expect(internal.details).not.toContain('postgres');
    expect(errors.some((e) => e.startsWith('CancelFraudTickets:'))).toBe(true);
  });
});
