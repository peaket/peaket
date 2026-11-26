// 주문 승인 근거 내부 조회(F-06-3 IR-03, transfer-refund §7.2, identity §5).
// ops의 재량 면제 판정과 identity의 미성년 나이 판정이 읽는다. 좌석·연락처·카드·계좌는 싣지 않는다.
import { ProblemError } from '@peaket/platform';
import type { CancellationOrderView, CancellationOrders, CancellationRecord } from '../../refund/index.js';

export interface OrderApprovalBasis {
  orderId: string;
  payerAccountId: string;
  paidAt: string;
  orderStatus: string;
  eventStartsAt: string | null;
  entryOpensAt: string | null;
  entryRecorded: boolean;
  refundableAmount: number;
}
export interface MinorContractBasis {
  orderId: string;
  payerAccountId: string;
  paidAt: string;
  orderStatus: string;
  eventStartsAt: string | null;
  entryOpensAt: string | null;
  entryRecorded: boolean;
}

/** 내부 경로(IR-03): /internal/v1/orders/{orderId}/approval-basis, /internal/v1/orders/{orderId}/minor-contract-basis */
export const APPROVAL_BASIS_PATH = '/internal/v1/orders/{orderId}/approval-basis';
export const MINOR_CONTRACT_BASIS_PATH = '/internal/v1/orders/{orderId}/minor-contract-basis';

export class ApprovalBasisOrders {
  constructor(private readonly orders: CancellationOrders) {}

  async basis(orderId: string): Promise<OrderApprovalBasis | undefined> {
    const rows: CancellationOrderView[] = (await this.orders.byOrder?.(orderId)) ?? [];
    if (rows.length === 0) return undefined;
    const first = rows[0]!;
    const paidAtMs = first.paidAtMs ?? first.bookedAtMs;
    const refundable = rows.reduce((sum, r) => sum + (r.refundableAmount ?? r.ticketPrice), 0);
    return {
      orderId,
      payerAccountId: first.payerAccountId,
      paidAt: new Date(paidAtMs).toISOString(),
      orderStatus: first.orderStatus,
      eventStartsAt: first.eventStartsAtMs === undefined ? null : new Date(first.eventStartsAtMs).toISOString(),
      entryOpensAt: first.entryOpensAtMs === undefined ? null : new Date(first.entryOpensAtMs).toISOString(),
      entryRecorded: first.entryRecorded === true,
      refundableAmount: refundable,
    };
  }

  async minorContractBasis(orderId: string): Promise<MinorContractBasis | undefined> {
    const b = await this.basis(orderId);
    if (!b) return undefined;
    const { refundableAmount: _omit, ...rest } = b;
    return rest;
  }

  /** 주문의 이전 취소(중복 환급 방지, IR-10). 없으면 빈 배열 */
  async cancellationsOf(orderId: string): Promise<CancellationRecord[]> {
    return (await this.orders.cancellationsOf?.(orderId)) ?? [];
  }

  /** 좌석·연락처 없이 화면 표시용 최소 값 */
  static viewOf(v: CancellationOrderView): { ticketId: string; payerAccountId: string } {
    if (!v.ticketId) throw new ProblemError({ type: 'not-found', status: 404, title: '주문 항목을 찾지 못했습니다' });
    return { ticketId: v.ticketId, payerAccountId: v.payerAccountId };
  }
}
