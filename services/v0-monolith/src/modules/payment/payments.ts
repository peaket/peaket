// 모듈 공개 함수: 결제 확정(docs/features/payment.md §13 동작 2 ③). booking 모듈이 결제 확정 안에서 부른다(HTTP 경로 없음).
// 조립 파일이라 층 규칙의 밖이다: 결제 행 어댑터를 만들어 유스케이스에 넣는다.
import type { Database } from '@peaket/platform';
import type { PaymentGatewayPort } from '@peaket/payment-svc/payment';
import { DrizzlePaymentStore } from './adapters/db/drizzle-payment-store.js';
import { paymentsWith } from './application/payments.js';
import type { Payments } from './domain/payment.js';

export function createPayments(database: Database, gateway: PaymentGatewayPort): Payments {
  return paymentsWith(new DrizzlePaymentStore(database), gateway);
}
