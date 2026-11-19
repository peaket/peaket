// 받는 층: gRPC CompensationTransferService(payment/v1/payment.proto, BAT-425 GAT-130 잔여).
// 실제 지급대행이 없으면 UNAVAILABLE 상태를 돌려주고, 부르는 쪽(ops-svc)이 503으로 드러낸다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { CompensationTransferProblem, type CompensationTransfers } from '../application/compensation-transfers.js';
import type { CompensationTransferStatus } from '../domain/ports.js';

export interface CompensationTransferPackage {
  CompensationTransferService: grpc.ServiceClientConstructor;
}

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
let pkg: CompensationTransferPackage | undefined;

export function compensationTransferPackage(): CompensationTransferPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: CompensationTransferPackage } } }).peaket.payment.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATUS: Readonly<Record<CompensationTransferStatus, string>> = {
  REQUESTED: 'COMPENSATION_TRANSFER_STATUS_REQUESTED',
  PAID: 'COMPENSATION_TRANSFER_STATUS_PAID',
  FAILED: 'COMPENSATION_TRANSFER_STATUS_FAILED',
  UNAVAILABLE: 'COMPENSATION_TRANSFER_STATUS_UNAVAILABLE',
};

const statusOf = (err: unknown): grpc.ServiceError => {
  if (err instanceof CompensationTransferProblem) {
    const code = err.code === 'NOT_FOUND' ? grpc.status.NOT_FOUND : err.code === 'UNAVAILABLE' ? grpc.status.UNAVAILABLE : grpc.status.INVALID_ARGUMENT;
    return { code, details: err.message } as grpc.ServiceError;
  }
  return { code: grpc.status.UNAVAILABLE, details: '지금은 배상 송금을 할 수 없습니다' } as grpc.ServiceError;
};

export function compensationTransferHandlers(useCases: Pick<CompensationTransfers, 'request' | 'get'>): grpc.UntypedServiceImplementation {
  const unary =
    (fn: (r: Req) => Promise<object>): grpc.handleUnaryCall<Req, object> =>
    (call, cb) => {
      fn(call.request).then(
        (v) => cb(null, v),
        (err: unknown) => cb(statusOf(err)),
      );
    };
  return {
    RequestCompensationTransfer: unary(async (r) => {
      const out = await useCases.request({
        compensationId: text(r.compensation_id),
        orderId: text(r.order_id),
        accountId: text(r.account_id),
        amount: Number(r.amount),
        bankCode: text(r.bank_code),
        accountNumber: text(r.account_number),
        holderName: text(r.holder_name),
        requestedBy: text(r.requested_by),
        promoterId: text(r.promoter_id),
        ...(text(r.event_id) === '' ? {} : { eventId: text(r.event_id) }),
      });
      return {
        transfer_id: out.transferId,
        status: STATUS[out.status],
        ...(out.failureReason !== undefined ? { failure_reason: out.failureReason } : {}),
        ...(out.receivableId !== undefined ? { receivable_id: out.receivableId } : {}),
        ...(out.accountLast4 !== undefined ? { account_last4: out.accountLast4 } : {}),
      };
    }),
    GetCompensationTransfer: unary(async (r) => {
      const out = await useCases.get(text(r.transfer_id));
      return { transfer_id: out.transferId, compensation_id: out.compensationId, amount: out.amount, status: STATUS[out.status], ...(out.failureReason !== undefined ? { failure_reason: out.failureReason } : {}) };
    }),
  };
}
