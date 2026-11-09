// 결제사 웹훅 받기(docs/features/payment.md §5 '웹훅 받기의 첫 구현', BUILD_ORDER HOT-150, ADR-0029 결정 5).
// 본문의 상태·금액을 믿지 않는다. 할 수 있는 일은 수신 기록과 다음 단독 조회를 당기는 신호뿐이다(명세 specs/payment.qnt `query`).
// 구현에서 정한 것(정본·설계에 없다):
// - 본문 상한은 라우트의 @BodyLimit이 해석 전에 413으로 막아 여기까지 오지 않는다(큰 본문을 읽거나 서명을 계산하지 않는다).
// - 어댑터가 없는 경로는 INVALID와 같게 답하고 지표만 no_adapter다(포트원 설정이 없는 환경의 포트원 경로).
// - 토스 경로의 본문은 토스 어댑터가, 없으면(local·ci) 시뮬레이터 어댑터가 읽는다. 둘은 같은 코드다(toss-shaped.ts).
import type { Clock } from '@peaket/platform';
import type { HeaderBag, PaymentGatewayPort, PgName } from '../domain/payment-gateway.js';
import type { PaymentGateways, PaymentWebhookLog, PaymentWebhookSignals, PaymentWebhookStore, WebhookReceiveRequest } from '../domain/ports.js';
import { type WebhookRoute, webhookRoutePgs, webhookRouteRejects, webhookRouteSigned } from '../domain/webhook-receipt.js';
import { safeErrorCode } from '../../../safe-error-code.js';

export interface ReceivePaymentWebhookDeps {
  store: PaymentWebhookStore;
  gateways: PaymentGateways;
  log: PaymentWebhookLog;
  signals: PaymentWebhookSignals;
  clock: Clock;
  /** 토스 경로에서 시뮬레이터도 받는가(local·ci에서만 참) */
  allowSimulator: boolean;
}

/** ACCEPTED 200, REJECTED 400, STORE_FAILED 503(결제사가 다시 보낸다) */
export type WebhookAnswer = 'ACCEPTED' | 'REJECTED' | 'STORE_FAILED';

/** 어댑터가 없을 때 지표·로그에 쓰는 그 경로의 결제사 */
const ROUTE_PG: Readonly<Record<WebhookRoute, PgName>> = { toss: 'TOSS', portone: 'PORTONE' };

export class ReceivePaymentWebhook {
  constructor(private readonly deps: ReceivePaymentWebhookDeps) {}

  /** 던지지 않는다(저장 실패는 STORE_FAILED다) */
  async receive(route: WebhookRoute, headers: HeaderBag, rawBody: Buffer): Promise<WebhookAnswer> {
    const { log, signals } = this.deps;
    const gateway = this.#gatewayOf(route);
    const pg = gateway?.pg ?? ROUTE_PG[route];
    if (gateway === undefined) {
      signals.outcome(pg, 'no_adapter');
      log.invalid({ route, pg, reason: 'NO_ADAPTER' });
      return this.#rejection(route);
    }
    const parsed = gateway.parseWebhook(headers, rawBody.toString('utf8'));
    if (parsed.kind === 'IGNORED') {
      signals.outcome(pg, 'ignored');
      return 'ACCEPTED';
    }
    if (parsed.kind === 'INVALID') {
      signals.outcome(pg, 'invalid');
      log.invalid({ route, pg, reason: parsed.reason });
      return this.#rejection(route);
    }
    const request: WebhookReceiveRequest = {
      pg,
      dedupKey: parsed.dedupKey,
      ...(parsed.paymentRef === undefined ? {} : { paymentRef: parsed.paymentRef }),
      ...(parsed.orderRef === undefined ? {} : { orderRef: parsed.orderRef }),
      allowedPgs: webhookRoutePgs(route, this.deps.allowSimulator),
      signed: webhookRouteSigned(route),
      nowMs: this.deps.clock.now(),
    };
    return this.#store(route, pg, request);
  }

  async #store(route: WebhookRoute, pg: PgName, request: WebhookReceiveRequest): Promise<WebhookAnswer> {
    const { log, signals, store } = this.deps;
    let result;
    try {
      result = await store.receive(request);
    } catch (err) {
      signals.outcome(pg, 'store_failed');
      log.storeFailed({ route, pg, code: safeErrorCode(err) });
      return 'STORE_FAILED';
    }
    switch (result.kind) {
      case 'DUPLICATE':
        signals.outcome(pg, 'duplicate');
        break;
      case 'LEDGER_NOT_FOUND':
        signals.outcome(pg, 'ledger_not_found');
        break;
      case 'PG_MISMATCH':
        signals.outcome(pg, 'pg_mismatch');
        log.pgMismatch({ route, pg, ledgerPg: result.ledgerPg, orderId: result.orderId });
        break;
      case 'QUERY_SIGNAL':
        signals.outcome(pg, 'query_signal');
        break;
      case 'QUERY_SIGNAL_SKIPPED':
        signals.outcome(pg, 'query_signal_skipped');
        break;
      case 'STATE_IGNORED':
        signals.outcome(pg, 'state_ignored');
        break;
    }
    return 'ACCEPTED';
  }

  #rejection(route: WebhookRoute): WebhookAnswer {
    return webhookRouteRejects(route) ? 'REJECTED' : 'ACCEPTED';
  }

  #gatewayOf(route: WebhookRoute): PaymentGatewayPort | undefined {
    const { gateways, allowSimulator } = this.deps;
    if (route === 'portone') return gateways.of('PORTONE');
    return gateways.of('TOSS') ?? (allowSimulator ? gateways.of('SIMULATOR') : undefined);
  }
}
