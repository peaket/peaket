// 결제 v0 포트: 결제 행 저장소(PostgreSQL). 결제사는 payment-svc 결제 모듈의 결제 포트(PaymentGatewayPort)다.

export type PaymentInsert = { kind: 'inserted'; paymentId: string } | { kind: 'already-exists' };

export interface PaymentStore {
  /** CONFIRMING 행을 넣는다. 그 주문의 행이 이미 있으면 already-exists */
  insertConfirming(r: { orderId: string; eventId: string; pg: string; paymentKey: string; amount: number; nowMs: number }): Promise<PaymentInsert>;
  markApproved(paymentId: string, approvedAtMs: number): Promise<void>;
  markFailed(paymentId: string, failure: string): Promise<void>;
}
