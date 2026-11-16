// 결제 후 일반 취소(부분·전액) 쓰임새(GAT-080, docs/features/payment.md §4.1).
// 차례: 원장 읽기 → 취소 건 만들기·찾기(payment_cancel, 트랜잭션) → (3시간 지난 재시도는 먼저 조회) → 결제사 부분 취소(저장한 본문) → 행·원장 반영(트랜잭션).
// 잠금을 쥔 채 결제사를 부르지 않는다. 결제사가 결과를 모르면 원장을 바꾸지 않고 UNKNOWN으로 답한다(부른 쪽이 같은 취소 ID로 다시 부른다).
// BAT-415 시험 담당의 빈 뼈대: 새 포트 모양(BAT-415 계획 §3 몫 P)에 맞춘 동작은 구현 담당이 채운다(앞 동작은 git 기록 ea97ea64에 있다).
import type { Clock } from '@peaket/platform';
import type { ConfirmedCancelAnswer, ConfirmedCancelInput } from '../domain/confirmed-cancel.js';
import type { PgCallGuards } from '../domain/pg-call-guard.js';
import type { CallBudget, PaymentConfirmedCancels, PaymentGateways } from '../domain/ports.js';

export interface CancelConfirmedPaymentDeps {
  store: PaymentConfirmedCancels;
  gateways: PaymentGateways;
  guards: Pick<PgCallGuards, 'of'>;
  clock: Clock;
}

export class CancelConfirmedPayment {
  constructor(readonly deps: CancelConfirmedPaymentDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀렸다·요청액이 남은 금액과 진행 중 합을 넘는다·같은 취소 ID에 다른 금액(INVALID_ARGUMENT)
   * @throws PaymentNotFoundError 결제가 없다(NOT_FOUND)
   * @throws PaymentCancelStateError 승인·부분 취소 상태가 아니다·남은 금액이 없다(FAILED_PRECONDITION)
   */
  async execute(_input: ConfirmedCancelInput, _budget?: CallBudget): Promise<ConfirmedCancelAnswer> {
    throw new Error('아직 없음');
  }
}
