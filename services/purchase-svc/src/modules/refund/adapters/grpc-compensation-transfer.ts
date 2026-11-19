// payment-svc CompensationTransferService 클라이언트(BAT-425 GAT-130 잔여, payment.proto, ADR-0317).
// compensation_id가 멱등 키이고, 계좌는 이 요청에만 싣는다(저장·로그 없음, POL-014). 한 번의 기한은 5초 [가정]이다.
// UNAVAILABLE은 CompensationTransferUnavailable로 던져 받는 층이 503 compensation-transfer-unavailable로 답한다.
// 그 밖의 실패(연결 실패·시간 초과·INVALID_ARGUMENT 등)는 CompensationTransferRejected로 던져 422로 답한다(재송금은 CS 판단).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { CompensationTransferRejected, CompensationTransferUnavailable } from '../domain/compensation.js';
import type { CompensationTransfer, CompensationTransferResult } from '../domain/ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type TransferPackage = { CompensationTransferService: grpc.ServiceClientConstructor };

let loaded: TransferPackage | undefined;
function transferPackage(): TransferPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: TransferPackage } } }).peaket.payment.v1;
  }
  return loaded;
}

const STATUS: Readonly<Record<string, CompensationTransferResult['status']>> = {
  COMPENSATION_TRANSFER_STATUS_REQUESTED: 'REQUESTED',
  COMPENSATION_TRANSFER_STATUS_PAID: 'PAID',
  COMPENSATION_TRANSFER_STATUS_FAILED: 'FAILED',
};
const DEADLINE_MS = 5_000;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface GrpcCompensationTransferOptions {
  address: string;
  profile?: GrpcLbProfile;
  /** 부르는 서비스 이름(감사·로그용 requested_by). 기본 purchase-svc */
  requestedBy?: string;
}

export class GrpcCompensationTransfer implements CompensationTransfer {
  readonly #client: grpc.Client & { RequestCompensationTransfer: Unary };
  readonly #requestedBy: string;

  constructor(o: GrpcCompensationTransferOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_PAYMENT_GRPC_ADDR는 host:port여야 한다');
    this.#client = createGrpcClient(transferPackage().CompensationTransferService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'payment-svc',
      timeoutCapMs: DEADLINE_MS,
    }) as unknown as grpc.Client & { RequestCompensationTransfer: Unary };
    this.#requestedBy = o.requestedBy ?? 'purchase-svc';
  }

  async request(q: Parameters<CompensationTransfer['request']>[0]): Promise<CompensationTransferResult> {
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#client.RequestCompensationTransfer(
        {
          compensation_id: q.compensationId,
          order_id: q.orderId,
          account_id: q.accountId,
          amount: q.amount,
          bank_code: q.account.bankCode,
          account_number: q.account.accountNumber,
          holder_name: q.account.holderName,
          requested_by: this.#requestedBy,
          ...(q.promoterId !== undefined && q.promoterId !== '' ? { promoter_id: q.promoterId } : {}),
          ...(q.eventId !== undefined && q.eventId !== '' ? { event_id: q.eventId } : {}),
        },
        new grpc.Metadata(),
        { deadline: new Date(Date.now() + DEADLINE_MS) },
        (e, v) => (e ? reject(e) : resolve(v ?? {})),
      );
    }).catch((err: unknown) => {
      const code = typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : undefined;
      if (code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED) {
        throw new CompensationTransferUnavailable('지금은 배상금을 보낼 수 없습니다', { cause: err });
      }
      throw new CompensationTransferRejected('배상금 송금 요청을 보내지 못했습니다', { cause: err });
    });
    const raw = text(answer.status);
    if (raw === 'COMPENSATION_TRANSFER_STATUS_UNAVAILABLE') throw new CompensationTransferUnavailable();
    const status = STATUS[raw];
    if (status === undefined) throw new CompensationTransferRejected('배상금 송금 답의 상태를 알 수 없습니다');
    return {
      transferId: text(answer.transfer_id),
      status,
      ...(text(answer.receivable_id) !== '' ? { receivableId: text(answer.receivable_id) } : {}),
      ...(text(answer.account_last4) !== '' ? { accountLast4: text(answer.account_last4) } : {}),
      ...(text(answer.failure_reason) !== '' ? { failureReason: text(answer.failure_reason) } : {}),
    };
  }

  close(): void {
    this.#client.close();
  }
}
