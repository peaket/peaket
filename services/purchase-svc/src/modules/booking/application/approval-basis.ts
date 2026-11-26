// 주문 승인 근거 내부 조회(F-06-3 IR-03, transfer-refund §7.2, identity §5).
// ops의 재량 면제 판정과 identity의 미성년 나이 판정이 읽는다. 좌석·연락처·카드·계좌는 싣지 않는다.
import { ProblemError } from '@peaket/platform';
import type { CancellationOrderView, CancellationOrders, CancellationRecord } from '../../refund/index.js';

export interface OrderApprovalBasis {
  orderId: string;
  eventId: string;
  payerAccountId: string;
  paidAt: string;
  orderStatus: string;
  eventStartsAt: string | null;
  entryOpensAt: string | null;
  entryRecorded: boolean;
  refundableAmount: number;
  /** 무효화할 발권 세대(없으면 0) */
  issueGeneration: number;
}
export interface MinorContractBasis {
  orderId: string;
  payerAccountId: string;
  paidAt: string;
  orderStatus: string;
  eventStartsAt: string | null;
  entryOpensAt: string | null;
  entryRecorded: boolean;
  /** 무효화할 발권 세대(없으면 0) */
  issueGeneration: number;
}

/** 내부 경로(IR-03): /internal/v1/orders/{orderId}/approval-basis, /internal/v1/orders/{orderId}/minor-contract-basis */
export const APPROVAL_BASIS_PATH = '/internal/v1/orders/{orderId}/approval-basis';
export const MINOR_CONTRACT_BASIS_PATH = '/internal/v1/orders/{orderId}/minor-contract-basis';

export class ApprovalBasisOrders {
  constructor(private readonly orders: CancellationOrders) {}

  /**
   * 주문 ID 또는 취소 ID로 승인 근거를 읽는다(IR-11). FLAGGED 건의 대상은 취소 ID라서 그대로 주문으로 찾으면 404다.
   * 입장 기록은 주문의 모든 티켓을 보고 하나라도 있으면 참이다(IR-03·31).
   */
  async basis(orderRef: string): Promise<OrderApprovalBasis | undefined> {
    let rows: CancellationOrderView[] = (await this.orders.byOrder?.(orderRef)) ?? [];
    let cancellation: CancellationRecord | undefined;
    if (rows.length === 0) {
      cancellation = await this.orders.findCancellation(orderRef);
      if (!cancellation) return undefined;
      rows = (await this.orders.byOrder?.(cancellation.orderId)) ?? [];
    }
    if (rows.length === 0) return undefined;
    const first = rows[0]!;
    const paidAtMs = first.paidAtMs ?? first.bookedAtMs;
    const refundable = rows.reduce((sum, r) => sum + (r.refundableAmount ?? r.ticketPrice), 0);
    const eventStarts = rows.find((r) => r.eventStartsAtMs !== undefined)?.eventStartsAtMs;
    const entryOpens = rows.find((r) => r.entryOpensAtMs !== undefined)?.entryOpensAtMs;
    return {
      orderId: first.orderId,
      eventId: first.eventId,
      payerAccountId: first.payerAccountId,
      paidAt: new Date(paidAtMs).toISOString(),
      orderStatus: first.orderStatus,
      eventStartsAt: eventStarts === undefined ? null : new Date(eventStarts).toISOString(),
      entryOpensAt: entryOpens === undefined ? null : new Date(entryOpens).toISOString(),
      entryRecorded: rows.some((r) => r.entryRecorded === true),
      // FLAGGED 취소는 그 취소 행의 환급액이 곧 남은 환급액이다(진행 중 취소가 티켓 금액을 이미 덮는다)
      refundableAmount: Math.max(refundable, cancellation?.refundAmount ?? 0),
      issueGeneration: first.issueGeneration ?? 0,
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
