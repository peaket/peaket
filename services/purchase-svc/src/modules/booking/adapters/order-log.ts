// 주문 생성의 보안·설정 로그를 서비스 로거(platform PlatformLogger)에 한 줄씩 남기는 어댑터(OrderLog, ADR-0055, BUILD_ORDER PRF-161).
// 번호 원문·토큰·pid는 싣지 않는다. 대체 판정은 warn(보안 로그), 설정 오류는 error(kind config, 재확인 설정 오류는 SEV2)다.
import type { PlatformLogger } from '@peaket/platform';
import type { AcceptLog, OrderLog, SagaLog } from '../domain/ports.js';

/**
 * - identityFallback: warn 한 줄 { kind: 'security', event: 'identity_recheck_fallback', accountId, reason, passed, idempotencyKey }
 * - configError: error 한 줄 { kind: 'config', what, eventId?·tierId?(가격 없음·합 넘침), reason?·severity SEV2(재확인) }
 * - payingMarkFailed: warn 한 줄 { event: 'order_paying_mark_failed', purchaseSessionId, orderId }
 * - attemptMismatch(결제 접수, PRF-162): warn 한 줄 { kind: 'security', event: 'payment_attempt_mismatch', accountId, orderId, reason }(결제 참조·본문 값·금액은 싣지 않는다).
 *   금액 불일치(400)도 같은 줄이고 reason이 amount_mismatch다
 * 로거가 던져도 삼킨다(부른 쪽을 막지 않는다)
 */
export class LoggerOrderLog implements OrderLog, AcceptLog {
  constructor(private readonly logger: Pick<PlatformLogger, 'warn' | 'error'>) {}

  identityFallback(e: Parameters<OrderLog['identityFallback']>[0]): void {
    // 칸을 하나씩 골라 싣는다(받은 객체를 그대로 펼치지 않아 다른 칸이 섞여 들지 않게)
    const line = { kind: 'security', event: 'identity_recheck_fallback', accountId: e.accountId, reason: e.reason, passed: e.passed, idempotencyKey: e.idempotencyKey };
    try {
      this.logger.warn(line, e.passed ? '본인확인 재확인이 답하지 않아 토큰 판정으로 통과시켰다' : '본인확인 재확인이 답하지 않아 토큰 판정으로 거부했다');
    } catch {
      // 로그 실패는 주문을 막지 않는다
    }
  }

  configError(e: Parameters<OrderLog['configError']>[0]): void {
    let line: Record<string, unknown>;
    let msg: string;
    switch (e.what) {
      case 'tier_price_missing':
        line = { kind: 'config', what: e.what, eventId: e.eventId, tierId: e.tierId };
        msg = '좌석맵 판에 가격이 없는 등급이 있어 주문을 만들지 않았다';
        break;
      case 'amount_out_of_range':
        line = { kind: 'config', what: e.what, eventId: e.eventId };
        msg = '등급 가격 합이 주문 금액 상한(int4)을 넘어 주문을 만들지 않았다';
        break;
      default:
        line = { kind: 'config', what: e.what, reason: e.reason, severity: 'SEV2' };
        msg = '본인확인 재확인 설정 오류(호출 신원·요청 값·정본 목록 밖의 답)로 주문을 503으로 답했다';
        break;
    }
    try {
      this.logger.error(line, msg);
    } catch {
      // 로그 실패는 응답을 바꾸지 않는다
    }
  }

  /** warn 한 줄 { event: 'order_paying_mark_failed', purchaseSessionId, orderId }(그 밖의 칸은 싣지 않는다, 리뷰 고침 M3) */
  payingMarkFailed(e: Parameters<OrderLog['payingMarkFailed']>[0]): void {
    try {
      this.logger.warn({ event: 'order_paying_mark_failed', purchaseSessionId: e.purchaseSessionId, orderId: e.orderId }, '주문 뒤 구매 세션 Paying 표시를 다시 불러도 하지 못했다(결제 중 유휴로 끝날 수 있다)');
    } catch {
      // 로그 실패는 응답을 바꾸지 않는다
    }
  }

  /** 결제 시도 대조 실패·금액 불일치 warn 한 줄(보안 사건, payment §4.2 18·ASVS 16.3.3). 계정·주문·까닭 세 칸만 싣는다 */
  attemptMismatch(e: Parameters<AcceptLog['attemptMismatch']>[0]): void {
    // 칸을 하나씩 골라 싣는다(받은 객체를 펼치지 않아 결제 참조·토큰·금액이 섞여 들지 않게)
    const line = { kind: 'security', event: 'payment_attempt_mismatch', accountId: e.accountId, orderId: e.orderId, reason: e.reason };
    try {
      this.logger.warn(line, e.reason === 'amount_mismatch' ? '결제 접수 본문 금액이 주문 금액과 달라 받지 않았다' : '결제 접수가 활성 결제 시도와 맞지 않아 받지 않았다');
    } catch {
      // 로그 실패는 응답을 바꾸지 않는다
    }
  }
}

/**
 * Saga 1단계 로그(SagaLog, BUILD_ORDER PRF-165). 결제 참조·토큰·금액은 싣지 않는다. 로거가 던져도 삼킨다.
 * - releaseFailed: warn 한 줄 { event: 'order_saga_release_failed', orderId, eventId, why }
 * - confirmRejected: error 한 줄 { kind: 'config', event: 'order_saga_confirm_rejected', orderId, reason, severity: 'SEV2' }
 * - stepError: error 한 줄 { event: 'order_saga_step_error', orderId, step, err }
 */
export class LoggerSagaLog implements SagaLog {
  constructor(private readonly logger: Pick<PlatformLogger, 'warn' | 'error'>) {}

  // 칸을 하나씩 골라 싣는다(받은 객체를 펼치지 않아 결제 참조·토큰·금액이 섞여 들지 않게)

  releaseFailed(e: Parameters<SagaLog['releaseFailed']>[0]): void {
    try {
      this.logger.warn(
        { event: 'order_saga_release_failed', orderId: e.orderId, eventId: e.eventId, why: e.why },
        'Saga 실패 해제를 끝내지 못했다(주문은 FAILED다. 남은 묶음은 좌석 해제 사건 소비자가 받는다)',
      );
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  confirmRejected(e: Parameters<SagaLog['confirmRejected']>[0]): void {
    try {
      this.logger.error(
        { kind: 'config', event: 'order_saga_confirm_rejected', orderId: e.orderId, reason: e.reason, severity: 'SEV2' },
        '승인 명령이 정해진 거절로 끝났다(설정·코드 오류로 보고 작업을 1시간 [가정] 멈춘다. 결과 당기기가 맞춘다)',
      );
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  stepError(e: Parameters<SagaLog['stepError']>[0]): void {
    try {
      this.logger.error({ event: 'order_saga_step_error', orderId: e.orderId, step: e.step, err: errorSummaryOf(e.err) }, 'Saga 단계가 예상 밖 오류로 끝나 다시 하기로 미뤘다');
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }
}

/** 오류의 이름·글만(스택·원인·다른 칸은 싣지 않는다) */
function errorSummaryOf(err: unknown): { name: string; message: string } | string {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return typeof err === 'string' ? err : typeof err;
}
