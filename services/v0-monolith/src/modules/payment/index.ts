// 이 모듈의 공개 파일. 다른 컨텍스트는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
// 결제 v0는 HTTP 경로가 없다. booking 모듈이 결제 확정 안에서 confirm을 부른다(docs/features/payment.md §13 동작 2 ③).
export { createPayments } from './payments.js';
export { createV0PaymentGateway, type V0PaymentGatewayOptions } from './gateway.js';
export { ApprovalNotRecordedError, PAYMENT_STATUSES, type PaymentRequest, type PaymentResult, type PaymentStatus, type Payments } from './domain/payment.js';
export type { PaymentGatewayPort } from '@peaket/payment-svc/payment';
