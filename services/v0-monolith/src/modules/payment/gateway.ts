// v0 결제사 연결: payment-svc 결제 모듈의 시뮬레이터 어댑터를 그대로 만든다(docs/features/payment.md §13 '결제 포트').
// v0는 결제창 값을 쓰지 않으므로(결제창 인증은 시험 시나리오가 시뮬레이터 시험용 인증으로 대신한다) 결제창용 공개 키는 자리만 채운다.
import type { Clock } from '@peaket/platform';
import { SimulatorPaymentGateway, type PaymentGatewayPort } from '@peaket/payment-svc/payment';

export interface V0PaymentGatewayOptions {
  /** 시뮬레이터 주소(환경 값 PEAKET_V0_PG_URL) */
  baseUrl: string;
  /** sim_sk_ 시험 키(환경 값 PG_SIMULATOR_SECRET_KEY) */
  secretKey: string;
  /** 읽기 시간 초과(ms). 기본은 어댑터 기본 60초 [가정] */
  readTimeoutMs?: number;
  clock?: Clock;
  fetch?: typeof fetch;
}

export function createV0PaymentGateway(o: V0PaymentGatewayOptions): PaymentGatewayPort {
  return new SimulatorPaymentGateway({
    baseUrl: o.baseUrl,
    secretKey: o.secretKey,
    clientKey: 'v0-no-checkout',
    ...(o.readTimeoutMs === undefined ? {} : { readTimeoutMs: o.readTimeoutMs }),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}
