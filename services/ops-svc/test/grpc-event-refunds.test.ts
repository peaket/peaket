// R-T40 ⑤ ops-svc 일괄 환불 gRPC 어댑터가 계좌 대기 수를 읽는다(BAT-420-rest 리뷰 반영 RV-05, 시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/payment.md §6 '계좌 대기' 끝(ops-svc는 GetEventRefundJob.account_pending_orders를 관제 상세 progress.accountPending에 싣는다),
// docs/features/transfer-refund.md §11 R-T40 ⑤, docs/api/proto/peaket/purchase/v1/refund.proto GetEventRefundJobResponse.account_pending_orders.
// 받는 쪽은 계약 설명자(@peaket/contracts/proto)로 만든 시험 gRPC 서버다(Docker 없음). 구현이 맞출 이름: EventRefundJobProgress.accountPending(정수, 필수 아님).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Refund } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcEventRefunds } from '../src/adapters/grpc-event-refunds.js';

const REQUEST = '0194b000-0000-7000-8000-0000000c4001';
const EVENT = '0194b000-0000-7000-8000-0000000c4002';
const ORDER_A = '0194b000-0000-7000-8000-0000000c4011';
const ORDER_B = '0194b000-0000-7000-8000-0000000c4012';
let server: grpc.Server;
let address = '';
let answer: Record<string, unknown> = {};
/** RV-25: preview가 돌려주는 주문별 배상 목록과 Start가 받은 요청을 본다 */
let previewAnswer: Record<string, unknown> = {};
const received: { method: string; req: Record<string, unknown> }[] = [];

beforeAll(async () => {
  const def = protoLoader.fromJSON(purchaseV1Refund as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: { EventRefundService: grpc.ServiceClientConstructor } } } }).peaket.purchase.v1;
  server = new grpc.Server();
  server.addService(pkg.EventRefundService.service, {
    GetEventRefundJob: (_call: unknown, cb: (e: null, v: unknown) => void) => cb(null, answer),
    PreviewEventRefund: (call: { request: Record<string, unknown> }, cb: (e: null, v: unknown) => void) => {
      received.push({ method: 'PreviewEventRefund', req: call.request });
      cb(null, previewAnswer);
    },
    StartEventRefund: (call: { request: Record<string, unknown> }, cb: (e: null, v: unknown) => void) => {
      received.push({ method: 'StartEventRefund', req: call.request });
      cb(null, { job_id: call.request.cancellation_request_id, state: 'REFUND_JOB_STATE_RUNNING' });
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  address = `127.0.0.1:${port}`;
});
afterAll(() => {
  server?.forceShutdown();
});

const base = {
  state: 'REFUND_JOB_STATE_COMPLETED',
  total_orders: 4,
  done_orders: 2,
  failed_orders: 0,
  per_pg: [{ pg: 'PG_PROVIDER_TOSS', state: 'REFUND_JOB_STATE_COMPLETED', done_orders: 2, failed_orders: 0, unknown_orders: 0 }],
  kind: 'EVENT_REFUND_KIND_CANCEL',
};

describe('R-T40 ⑤ GrpcEventRefunds.job의 계좌 대기 수', () => {
  test('R-T40 ⑤ account_pending_orders 2를 accountPending 2로 읽는다(결제사별 몫에는 싣지 않는다)', async () => {
    answer = { ...base, account_pending_orders: 2 };
    const a = new GrpcEventRefunds({ address });
    try {
      const job = await a.job({ requestId: REQUEST });
      expect(job).toMatchObject({ state: 'COMPLETED', total: 4, done: 2, failed: 0, accountPending: 2 });
      for (const p of job!.perPg) expect(p).not.toHaveProperty('accountPending');
    } finally {
      a.close();
    }
  });

  test('R-T40 ⑤ 칸이 없는 옛 답(proto3 기본값 0)은 0이다', async () => {
    answer = { ...base };
    const a = new GrpcEventRefunds({ address });
    try {
      expect(((await a.job({ requestId: REQUEST })) as { accountPending?: number } | undefined)?.accountPending ?? 0).toBe(0);
    } finally {
      a.close();
    }
  });
});

// RV-25(중간): ops-svc는 판정 미리보기의 주문별 배상 목록(compensation_orders)을 dry_run에 저장하고,
// 확정(승인) 때 StartEventRefund.compensation_orders로 그대로 되보내야 purchase-svc가 금액을 다시 계산하지 않는다.
// 어댑터가 preview·start 양쪽에서 이 칸을 빠뜨리면 팬이 본 배상액과 실제 저장·송금액이 달라진다.
describe('R-T46 ②·RV-25 Preview→Start의 compensation_orders 왕복', () => {
  test('R-T46 ②_RV25_Preview의_주문별_배상_Money를_읽고_Start에_같은_목록을_그대로_싣는다', async () => {
    previewAnswer = {
      target_orders: 2,
      refund_total: { krw: 53_335 },
      compensation_targets: 2,
      compensation_total: { krw: 5_335 },
      compensation_orders: [
        { order_id: ORDER_A, base_amount: { krw: 20_002 }, amount: { krw: 2_001 } },
        { order_id: ORDER_B, base_amount: { krw: 33_333 }, amount: { krw: 3_334 } },
      ],
      per_pg: [],
    };
    const a = new GrpcEventRefunds({ address });
    try {
      const preview = await a.preview({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER' });
      expect(preview.compensationOrders).toEqual([
        { orderId: ORDER_A, baseAmount: 20_002, amount: 2_001 },
        { orderId: ORDER_B, baseAmount: 33_333, amount: 3_334 },
      ]);
      expect(preview.compensationTargets).toBe(2);
      expect(preview.compensationTotal).toBe(5_335);

      received.length = 0;
      await a.start({
        eventId: EVENT,
        requestId: REQUEST,
        fault: 'ORGANIZER',
        ruledBy: 'operator-1',
        confirmedBy: 'commander-2',
        compensationOrders: preview.compensationOrders,
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        method: 'StartEventRefund',
        req: {
          event_id: EVENT,
          cancellation_request_id: REQUEST,
          compensation_orders: [
            { order_id: ORDER_A, base_amount: { krw: 20_002 }, amount: { krw: 2_001 } },
            { order_id: ORDER_B, base_amount: { krw: 33_333 }, amount: { krw: 3_334 } },
          ],
        },
      });
    } finally {
      a.close();
    }
  });
});
