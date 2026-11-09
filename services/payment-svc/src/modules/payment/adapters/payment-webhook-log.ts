// 웹훅 받기의 로그(BUILD_ORDER HOT-150, ASVS v5.0.0-16.2.5·16.3.1·16.3.3). 경로·결제사·닫힌 까닭·오류 코드와 어긋남의 주문 ID만 싣는다. 본문·머리 값·입금 secret은 싣지 않는다.
// 인증 없는 요청이 만들 수 있는 줄(거절, 서명 없는 경로의 어긋남)은 파드에서 같은 까닭마다 1분에 한 줄 [가정]이다. 건수는 지표 payment_webhook_received_total이 센다.
import type { PlatformLogger } from '@peaket/platform';
import { LogGate, type WallClock } from '../domain/log-gate.js';
import type { PaymentWebhookLog } from '../domain/ports.js';
import { WEBHOOK_REJECT_LOG_INTERVAL_MS, webhookRouteSigned } from '../domain/webhook-receipt.js';

/** 로그 때문에 응답이 실패하지 않게 로거의 예외를 삼킨다 */
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 삼킨다
  }
}

/**
 * 플랫폼 로거에 잇는다. 줄의 kind: invalid는 warn(payment-webhook-invalid), pgMismatch는 서명을 본 경로면 error·SEV2, 서명 없는 경로면 warn·SEV3(payment-webhook-pg-mismatch), storeFailed는 error(payment-webhook-store-failed, code). 로거가 던져도 삼킨다
 * @param clock 거절 줄의 문이 보는 시계
 */
export function paymentWebhookLog(logger: Pick<PlatformLogger, 'warn' | 'error'>, clock: WallClock): PaymentWebhookLog {
  // 열쇠는 경로·닫힌 사유·결제사의 곱이라 수가 정해져 있다(요청 값이 열쇠에 들어가지 않는다)
  const gates = new Map<string, LogGate>();
  const opens = (key: string): boolean => {
    let gate = gates.get(key);
    if (gate === undefined) {
      gate = new LogGate(clock, WEBHOOK_REJECT_LOG_INTERVAL_MS);
      gates.set(key, gate);
    }
    return gate.allow();
  };
  return {
    invalid: ({ route, pg, reason }) =>
      quietly(() => {
        if (opens(`invalid:${route}:${reason}`)) logger.warn({ kind: 'payment-webhook-invalid', route, pg, reason }, '결제사 웹훅을 거절했다');
      }),
    pgMismatch: ({ route, pg, ledgerPg, orderId }) =>
      quietly(() => {
        const fields = { kind: 'payment-webhook-pg-mismatch', route, pg, ledgerPg, orderId };
        const message = '웹훅 경로의 결제사와 원장의 결제사가 달라 조회하지 않았다';
        if (webhookRouteSigned(route)) logger.error({ ...fields, severity: 'SEV2' }, message);
        else if (opens(`mismatch:${route}:${ledgerPg}`)) logger.warn({ ...fields, severity: 'SEV3' }, message);
      }),
    storeFailed: ({ route, pg, code }) => quietly(() => logger.error({ kind: 'payment-webhook-store-failed', route, pg, code }, '웹훅 수신 기록을 쓰지 못했다(결제사가 다시 보낸다)')),
    depositSecretMismatch: ({ route, pg, orderId }) =>
      quietly(() => {
        if (opens(`deposit-secret:${route}`)) logger.warn({ kind: 'payment-webhook-deposit-secret-mismatch', severity: 'SEV3', route, pg, orderId }, '입금 통보의 secret이 원장과 달라 처리하지 않았다');
      }),
  };
}
