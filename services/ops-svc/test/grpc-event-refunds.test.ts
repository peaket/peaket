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
let server: grpc.Server;
let address = '';
let answer: Record<string, unknown> = {};

beforeAll(async () => {
  const def = protoLoader.fromJSON(purchaseV1Refund as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: { EventRefundService: grpc.ServiceClientConstructor } } } }).peaket.purchase.v1;
  server = new grpc.Server();
  server.addService(pkg.EventRefundService.service, {
    GetEventRefundJob: (_call: unknown, cb: (e: null, v: unknown) => void) => cb(null, answer),
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
