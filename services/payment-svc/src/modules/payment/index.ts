// payment-svc 결제 모듈의 공개 파일. 다른 모듈·패키지는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
// v0 모놀리스의 결제 모듈도 같은 결제 포트와 시뮬레이터 어댑터를 쓴다(docs/features/payment.md §13, 패키지 경로 @peaket/payment-svc/payment).
export {
  CANCEL_IDEM_KEY,
  confirmIdemKey,
  type CancelOutcome,
  type CancelResult,
  type CheckoutAttempt,
  type CheckoutOrder,
  type CheckoutValues,
  type ConfirmCard,
  type ConfirmOutcome,
  type ConfirmResult,
  type FailureCategory,
  type HeaderBag,
  type PaymentGatewayPort,
  type PayMethodCategory,
  type PgCapabilities,
  type PgName,
  type QueryResult,
  type QueryStatus,
  type WebhookInvalidReason,
  type WebhookParseResult,
  type WebhookTrigger,
} from './domain/payment-gateway.js';
export { SimulatorPaymentGateway, type SimulatorGatewayOptions } from './adapters/pg/simulator-gateway.js';
