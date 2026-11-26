// 지연 환급 계좌 입력 화면(SCR-060)이 읽는 취소 상세(F-07-15 I-03).
// 결제자 본인만 읽고, 남의 취소·없는 취소는 같은 404다. 계좌 원문은 싣지 않는다.
import { ProblemError } from '@peaket/platform';
import type { CancellationOrders } from '../domain/ports.js';

export interface CancellationDetail {
  cancellationId: string;
  orderId: string;
  eventId: string;
  refundAmount: number;
  deductionAmount: number;
  deductionBp: number;
  reason: string;
  status: string;
  refundAccountRequired: boolean;
  createdAt: string;
}

export class GetCancellationDetail {
  constructor(private readonly d: { orders: CancellationOrders }) {}

  async run(i: { cancellationId: string; accountId: string }): Promise<CancellationDetail> {
    const record = await this.d.orders.findCancellation(i.cancellationId);
    if (!record) throw notFound();
    const order = await this.d.orders.findByTicket(record.ticketId);
    if (!order || order.payerAccountId !== i.accountId) throw notFound();
    return {
      cancellationId: record.cancellationId,
      orderId: record.orderId,
      eventId: order.eventId,
      refundAmount: record.refundAmount,
      deductionAmount: record.deductionAmount ?? 0,
      deductionBp: record.deductionBp ?? 0,
      reason: record.reason ?? 'USER',
      status: record.state,
      refundAccountRequired: record.state === 'REFUND_PENDING' && record.refundAccountRequired === true,
      createdAt: (record.createdAt ?? new Date(0)).toISOString(),
    };
  }
}

const notFound = (): ProblemError => new ProblemError({ type: 'not-found', status: 404, title: '취소를 찾을 수 없습니다' });
