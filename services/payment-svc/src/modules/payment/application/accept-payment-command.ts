// 쓰임새: 승인 명령 접수(gRPC ConfirmPayment, docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180, 명세 specs/payment.qnt `command`).
// 입력 검사 → 저장(처음이면 원장·이력 첫 행·승인 명령을 한 트랜잭션으로) → 다시 왔으면 같은 명령인지 대조 → 답. 결제사는 부르지 않는다(PRF-181).
import { type Clock, uuidv7 } from '@peaket/platform';
import { type ConfirmAnswer, confirmAnswerOf, type ConfirmPaymentCommand, type ConfirmPaymentInput, isSameCommand, parseConfirmPaymentInput, PaymentCommandMismatchError } from '../domain/confirm-command.js';
import type { CallBudget, PaymentCommandLog, PaymentCommandSignals, PaymentCommandStore, StoreCommandResult } from '../domain/ports.js';

export interface AcceptPaymentCommandDeps {
  readonly store: PaymentCommandStore;
  readonly clock: Clock;
  readonly log: PaymentCommandLog;
  readonly signals: PaymentCommandSignals;
}

export class AcceptPaymentCommand {
  constructor(private readonly deps: AcceptPaymentCommandDeps) {}

  /**
   * @param budget 이 호출에 남은 시간(저장소의 문장 시간 한도 재료)
   * @returns 답(처음과 다시 온 같은 명령은 같은 답, confirmAnswerOf)
   * @throws PaymentInputError 입력이 틀림(지표 invalid, 쓰지 않는다)
   * @throws PaymentCommandMismatchError 이미 있는 결제와 attempt_id·pg·amount가 다름(지표 mismatch, SEV2 로그 mismatch, 행을 바꾸지 않는다)
   * 저장소 오류는 지표 error를 세고 그대로 던진다
   */
  async execute(input: ConfirmPaymentInput, budget?: CallBudget): Promise<ConfirmAnswer> {
    const { clock } = this.deps;
    let command: ConfirmPaymentCommand;
    try {
      command = parseConfirmPaymentInput(input, clock.now());
    } catch (err) {
      this.deps.signals.confirmCommand('invalid');
      throw err;
    }
    let result: StoreCommandResult;
    try {
      result = await this.deps.store.store(command, { paymentId: uuidv7(clock), eventKey: uuidv7(clock), nowMs: clock.now() }, budget);
    } catch (err) {
      this.deps.signals.confirmCommand('error');
      throw err;
    }
    if (result.kind === 'CREATED') {
      this.deps.signals.confirmCommand('accepted');
      return confirmAnswerOf(result.record);
    }
    if (!isSameCommand(result.record, command)) {
      this.deps.signals.confirmCommand('mismatch');
      this.deps.log.mismatch({ orderId: command.orderId });
      throw new PaymentCommandMismatchError();
    }
    this.deps.signals.confirmCommand('replayed');
    return confirmAnswerOf(result.record);
  }
}
