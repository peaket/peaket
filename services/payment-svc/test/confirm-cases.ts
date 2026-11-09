// 승인 명령 접수·결과 조회 단위 시험의 공통 값과 대역(BUILD_ORDER PRF-180, docs/features/payment.md §2 '승인 명령 접수의 첫 구현').
// 입력 예시, 원장 행 만들기, 포트 셋(저장소·로그·지표)의 메모리 대역, 오류 잡기 도우미를 둔다. 실제 PostgreSQL로 도는 것은 test-int가 본다.
import type { ConfirmPaymentCommand, ConfirmPaymentInput, PaymentRecord, PaymentState } from '../src/modules/payment/domain/confirm-command.js';
import type {
  BatchGetOutcome,
  CallBudget,
  ConfirmCommandOutcome,
  NewPaymentValues,
  PaymentCommandLog,
  PaymentCommandSignals,
  PaymentCommandStore,
  PaymentStateReader,
  StoreCommandResult,
} from '../src/modules/payment/domain/ports.js';

export const NOW = Date.parse('2026-11-09T03:00:00.000Z');
export const AUTHENTICATED_AT = Date.parse('2026-11-09T02:59:30.000Z');

/** 소문자 UUIDv7 모양의 예시 값 */
export const ORDER_ID = '0193a1b2-c3d4-7e5f-8a6b-1234567890a1';
export const ATTEMPT_ID = '0193a1b2-c3d4-7e5f-8a6b-1234567890a2';
export const EVENT_ID = '0193a1b2-c3d4-7e5f-8a6b-1234567890a3';
export const PAYMENT_ID = '0193a1b2-c3d4-7e5f-8a6b-1234567890a4';
export const OTHER_ATTEMPT_ID = '0193a1b2-c3d4-7e5f-8a6b-1234567890a5';

/** 로그·오류 글에 실리면 안 되는 값 */
export const SECRET_PAYMENT_KEY = 'tgen_SECRET-PAYMENT-KEY-1234';
export const SECRET_PAYMENT_TOKEN = 'SECRET-PORTONE-TOKEN-5678';
export const TX_ID = 'tx-0193a1b2-abcd';

export const tossInput = (over: Partial<ConfirmPaymentInput> = {}): ConfirmPaymentInput => ({
  orderId: ORDER_ID,
  attemptId: ATTEMPT_ID,
  attemptNo: 1,
  eventId: EVENT_ID,
  pg: 'TOSS',
  paymentRef: { kind: 'toss', paymentKey: SECRET_PAYMENT_KEY },
  amount: 55_000,
  authenticatedAtMs: AUTHENTICATED_AT,
  ...over,
});

export const portoneRef = (over: Partial<{ paymentId: string; txId: string; paymentToken: string }> = {}): NonNullable<ConfirmPaymentInput['paymentRef']> => ({
  kind: 'portone',
  paymentId: `pay-${ORDER_ID}`,
  txId: TX_ID,
  paymentToken: SECRET_PAYMENT_TOKEN,
  ...over,
});

export const portoneInput = (over: Partial<ConfirmPaymentInput> = {}): ConfirmPaymentInput => tossInput({ pg: 'PORTONE', paymentRef: portoneRef(), ...over });

export const recordOf = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  paymentId: PAYMENT_ID,
  orderId: ORDER_ID,
  attemptId: ATTEMPT_ID,
  pg: 'TOSS',
  amount: 55_000,
  status: 'ACCEPTED',
  ...over,
});

export const commandOf = (over: Partial<ConfirmPaymentCommand> = {}): ConfirmPaymentCommand => ({
  orderId: ORDER_ID,
  attemptId: ATTEMPT_ID,
  attemptNo: 1,
  eventId: EVENT_ID,
  pg: 'TOSS',
  paymentRef: { kind: 'toss', paymentKey: SECRET_PAYMENT_KEY },
  amount: 55_000,
  authenticatedAtMs: AUTHENTICATED_AT,
  ...over,
});

export const stateOf = (over: Partial<PaymentState> = {}): PaymentState => ({
  orderId: ORDER_ID,
  paymentId: PAYMENT_ID,
  pg: 'TOSS',
  status: 'ACCEPTED',
  amount: 55_000,
  ...over,
});

/** n번째 소문자 UUID(서로 다른 값) */
export const uuidAt = (n: number): string => `0193a1b2-c3d4-7e5f-8a6b-${n.toString(16).padStart(12, '0')}`;

/** 원장 표를 Map으로 흉내 낸 저장소. order_id가 같으면 쓰지 않고 있는 행을 돌려준다 */
export class FakeCommandStore implements PaymentCommandStore {
  readonly records = new Map<string, PaymentRecord>();
  readonly calls: { command: ConfirmPaymentCommand; values: NewPaymentValues; budget?: CallBudget }[] = [];
  /** 실제로 행을 쓴 횟수(CREATED) */
  writes = 0;
  failure: unknown = undefined;

  async store(command: ConfirmPaymentCommand, values: NewPaymentValues, budget?: CallBudget): Promise<StoreCommandResult> {
    this.calls.push({ command, values, ...(budget ? { budget } : {}) });
    if (this.failure !== undefined) throw this.failure;
    const existing = this.records.get(command.orderId);
    if (existing) return { kind: 'EXISTING', record: existing };
    this.writes += 1;
    const record: PaymentRecord = { paymentId: values.paymentId, orderId: command.orderId, attemptId: command.attemptId, pg: command.pg, amount: command.amount, status: 'ACCEPTED' };
    this.records.set(command.orderId, record);
    return { kind: 'CREATED', record };
  }
}

export class FakeStateReader implements PaymentStateReader {
  readonly calls: string[][] = [];
  readonly budgets: (CallBudget | undefined)[] = [];
  states: PaymentState[] = [];
  failure: unknown = undefined;

  async batchGet(orderIds: readonly string[], budget?: CallBudget): Promise<PaymentState[]> {
    this.calls.push([...orderIds]);
    this.budgets.push(budget);
    if (this.failure !== undefined) throw this.failure;
    return this.states;
  }
}

export class FakeCommandLog implements PaymentCommandLog {
  readonly mismatches: unknown[] = [];

  mismatch(e: { readonly orderId: string }): void {
    this.mismatches.push(e);
  }
}

export class FakeSignals implements PaymentCommandSignals {
  readonly confirm: ConfirmCommandOutcome[] = [];
  readonly batch: BatchGetOutcome[] = [];

  confirmCommand(outcome: ConfirmCommandOutcome): void {
    this.confirm.push(outcome);
  }

  batchGet(outcome: BatchGetOutcome): void {
    this.batch.push(outcome);
  }
}

/** fn이 던진 값. 던지지 않으면 시험을 실패시킨다 */
export function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('던지지 않았다');
}

/** promise가 거절한 값. 이행되면 시험을 실패시킨다 */
export async function rejectedBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('거절되지 않았다');
}
