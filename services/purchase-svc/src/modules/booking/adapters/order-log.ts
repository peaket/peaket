// 주문 생성의 보안·설정 로그를 서비스 로거(platform PlatformLogger)에 한 줄씩 남기는 어댑터(OrderLog, ADR-0055, BUILD_ORDER PRF-161).
// 번호 원문·토큰·pid는 싣지 않는다. 대체 판정은 warn(보안 로그), 설정 오류는 error(kind config, 재확인 설정 오류는 SEV2)다.
import { errorSummary, type PlatformLogger } from '@peaket/platform';
import type { AcceptLog, OrderLog, PaymentPullLog, PaymentResultLog, SagaLog, TicketIssueLog } from '../domain/ports.js';
import { TICKET_ISSUE_CS_CASE } from '../domain/ticket-issue.js';

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
 * - stepError: error 한 줄 { event: 'order_saga_step_error', orderId, step, err }. err는 플랫폼 errorSummary('이름: 글' 한 줄. Drizzle 쿼리 오류는
 *   쿼리 틀과 SQLSTATE만 싣고 매개변수 값은 싣지 않는다, ASVS v5.0.0-16.2.5, 리뷰 고침 M2)
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
      this.logger.error({ event: 'order_saga_step_error', orderId: e.orderId, step: e.step, err: errorSummary(e.err) }, 'Saga 단계가 예상 밖 오류로 끝나 다시 하기로 미뤘다');
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }
}

/**
 * 결제 결과 반영 로그(PaymentResultLog, BUILD_ORDER PRF-164가 trade.payments 소비자를 붙이며 만든다, docs/features/payment.md §2 '결제 결과 반영의 첫 구현').
 * 결제 참조·금액·토큰은 싣지 않는다(받은 객체를 펼치지 않고 칸을 하나씩 고른다). 로거가 던져도 삼킨다(처리기를 막지 않는다).
 * 같은 사건·까닭을 시간 창 안에서 한 번만 부르는 일은 ApplyPaymentResult가 한다(PAYMENT_RESULT_HELD_LOG_WINDOW_MS). 이 어댑터는 받은 대로 한 줄씩 남긴다.
 * - held: error 한 줄 { kind: 'payment-result-held', orderId, type, pg, reason, severity, holdKind?(e.kind가 있을 때만) }
 * - afterCommitFailed: warn 한 줄 { kind: 'payment-result', event: 'after_commit_failed', orderId, what, errorName }
 */
export class LoggerPaymentResultLog implements PaymentResultLog {
  constructor(private readonly logger: Pick<PlatformLogger, 'warn' | 'error'>) {}

  held(e: Parameters<PaymentResultLog['held']>[0]): void {
    // 칸을 하나씩 골라 싣는다(받은 객체를 펼치지 않아 결제 참조·토큰·금액·사건 키가 섞여 들지 않게). 표시(kind)는 있을 때만 holdKind로
    const line: Record<string, unknown> = { kind: 'payment-result-held', orderId: e.orderId, type: e.type, pg: e.pg, reason: e.reason, severity: e.severity };
    if (e.kind !== undefined) line.holdKind = e.kind;
    try {
      this.logger.error(line, '결제 결과를 주문에 반영하지 않고 보류한다(RB-11로 원인을 본다)');
    } catch {
      // 로그 실패는 처리기를 막지 않는다
    }
  }

  afterCommitFailed(e: Parameters<PaymentResultLog['afterCommitFailed']>[0]): void {
    try {
      this.logger.warn(
        { kind: 'payment-result', event: 'after_commit_failed', orderId: e.orderId, what: e.what, errorName: e.errorName },
        '결제 결과를 반영한 뒤 구매 세션 일을 하지 못했다(반영은 그대로다)',
      );
    } catch {
      // 로그 실패는 처리기를 막지 않는다
    }
  }
}

/**
 * 발권 실행기 로그(TicketIssueLog, BUILD_ORDER PRF-170). 좌석·계정·티켓 ID는 싣지 않는다(받은 객체를 펼치지 않고 칸을 하나씩 고른다). 로거가 던져도 삼킨다.
 * CS 건 요청 계약이 없어 csCase 표시로만 둔다(건 요청은 GAT-280).
 * - stopped: error 한 줄 { kind: 'ticket-issue', severity: 'SEV2', orderId, code, csCase: 'TICKET_NOT_ISSUED' }
 * - overdue: error 한 줄 { kind: 'ticket-issue-overdue', severity: 'SEV1', orderId, csCase: 'TICKET_NOT_ISSUED' }
 * - staleAnswer: warn 한 줄 { kind: 'ticket-issue', event: 'stale_answer', orderId, current? }
 * - runError: error 한 줄 { kind: 'ticket-issue', event: 'run_error', what, orderId?, err }. err는 플랫폼 errorSummary('이름: 글' 한 줄, 스택·원인 없음.
 *   Drizzle 쿼리 오류는 쿼리 틀과 SQLSTATE만 싣고 매개변수 값(주문·좌석·티켓 ID)은 싣지 않는다, ASVS v5.0.0-16.2.5, 리뷰 고침 M2)
 */
export class LoggerTicketIssueLog implements TicketIssueLog {
  constructor(private readonly logger: Pick<PlatformLogger, 'warn' | 'error'>) {}

  // 칸을 하나씩 골라 싣는다(받은 객체를 펼치지 않아 좌석·결제자 계정·티켓 ID가 섞여 들지 않게)

  stopped(e: Parameters<TicketIssueLog['stopped']>[0]): void {
    try {
      this.logger.error(
        { kind: 'ticket-issue', severity: 'SEV2', orderId: e.orderId, code: e.code, csCase: TICKET_ISSUE_CS_CASE },
        '발권이 다시 보내도 같은 결과일 오류로 끝나 자동 재시도를 멈췄다(결제 뒤 미발권, CS 처리함 건 요청은 GAT-280)',
      );
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  overdue(e: Parameters<TicketIssueLog['overdue']>[0]): void {
    try {
      this.logger.error(
        { kind: 'ticket-issue-overdue', severity: 'SEV1', orderId: e.orderId, csCase: TICKET_ISSUE_CS_CASE },
        '발권 기한(승인 + 30분 [가정])을 넘겼다(재시도는 최대 간격으로 이어 간다, ADR-0106 결정 2)',
      );
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  staleAnswer(e: Parameters<TicketIssueLog['staleAnswer']>[0]): void {
    const line: Record<string, unknown> = { kind: 'ticket-issue', event: 'stale_answer', orderId: e.orderId };
    if (e.current !== undefined) line.current = e.current;
    try {
      this.logger.warn(line, '늦게 온 발권 답: 주문이 APPROVED가 아니라 상태를 바꾸지 않고 발권 큐 행만 지웠다');
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  runError(e: Parameters<TicketIssueLog['runError']>[0]): void {
    const line: Record<string, unknown> = { kind: 'ticket-issue', event: 'run_error', what: e.what };
    if (e.orderId !== undefined) line.orderId = e.orderId;
    line.err = errorSummary(e.err);
    try {
      this.logger.error(line, '발권 실행기가 예상 밖 오류를 만났다(다음 틱이나 임대가 끝난 뒤 다시 한다)');
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }
}

/**
 * 결제 결과 당기기 로그(PaymentPullLog, BUILD_ORDER PRF-171, ADR-0140, docs/features/payment.md §2 '결제 결과 당기기의 첫 구현').
 * 금액·결제 참조·사건 키·결제 원장 ID는 싣지 않는다(받은 객체를 펼치지 않고 칸을 하나씩 고른다). 로거가 던져도 삼킨다(실행기를 막지 않는다).
 * 같은 주문의 기록 없음 줄을 창 안에서 한 번만 부르는 일은 실행기(PaymentResultPuller)가 한다. 이 어댑터는 받은 대로 한 줄씩 남긴다.
 * - missing: error 한 줄 { kind: 'payment-result-missing', severity: 'SEV2', orderId }(주문 ID만)
 * - ignored: warn 한 줄 { kind: 'payment-result-pull', event: 'ignored', orderId, reason, status }
 * - runError: error 한 줄 { kind: 'payment-result-pull', event: 'run_error', what, orderId?, err }. err는 플랫폼 errorSummary('이름: 글' 한 줄, 스택·원인 없음.
 *   Drizzle 쿼리 오류는 쿼리 틀과 SQLSTATE만 싣고 매개변수 값(주문 ID)은 싣지 않는다, ASVS v5.0.0-16.2.5)
 */
export class LoggerPaymentPullLog implements PaymentPullLog {
  constructor(private readonly logger: Pick<PlatformLogger, 'warn' | 'error'>) {}

  missing(e: Parameters<PaymentPullLog['missing']>[0]): void {
    try {
      this.logger.error(
        { kind: 'payment-result-missing', severity: 'SEV2', orderId: e.orderId },
        '승인 명령을 보낸 지 10분 [가정]이 지나도 payment-svc에 결제 기록이 없다(주문을 실패로 단정하지 않는다. 명령 기한 넘김 처리는 PRF-180)',
      );
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  ignored(e: Parameters<PaymentPullLog['ignored']>[0]): void {
    try {
      this.logger.warn(
        { kind: 'payment-result-pull', event: 'ignored', orderId: e.orderId, reason: e.reason, status: e.status },
        e.reason === 'CANCELED'
          ? '당긴 결제 결과가 취소 상태라 반영하지 않았다(취소 흐름은 PRF-173·환불 단계. 다음 점검을 60초 [가정] 미룬다)'
          : '당긴 결제 결과가 반영할 수 없는 모양이라 반영하지 않았다(다음 점검을 60초 [가정] 미룬다)',
      );
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }

  runError(e: Parameters<PaymentPullLog['runError']>[0]): void {
    const line: Record<string, unknown> = { kind: 'payment-result-pull', event: 'run_error', what: e.what };
    if (e.orderId !== undefined) line.orderId = e.orderId;
    line.err = errorSummary(e.err);
    try {
      this.logger.error(line, '결제 결과 당기기가 예상 밖 오류를 만났다(다음 틱이나 다음 점검에 다시 묻는다)');
    } catch {
      // 로그 실패는 실행기를 막지 않는다
    }
  }
}
