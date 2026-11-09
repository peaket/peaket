// 결제창 준비 쓰임새(docs/features/payment.md §2.2 '선택기의 첫 구현', BUILD_ORDER PRF-190). 결제사를 부르지 않고 쓰기가 없다.
import type { Clock } from '@peaket/platform';
import { PaymentInputError } from '../domain/confirm-command.js';
import { LogGate } from '../domain/log-gate.js';
import type { CheckoutValues, PayMethod, PgName } from '../domain/payment-gateway.js';
import { allowedPayMethods, checkoutReturnUrls, parsePrepareCheckoutInput, PaymentPgUnavailableError, type PgChannelTable, type PgPlatformDefaults, type PgSelectionState, type PgUnavailableReason, type PrepareCheckoutCommand, type PrepareCheckoutInput, selectPg } from '../domain/pg-selection.js';
import type { CallBudget, PaymentGateways, PgSelectionReader, PrepareCheckoutLog, PrepareCheckoutSignals } from '../domain/ports.js';
import { checkoutDepositDueAtMs } from '../domain/virtual-account.js';

/** 결제사를 고르지 못한 경보 로그의 간격 1분 [가정](결제사·까닭마다) */
const PG_UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

export interface PrepareCheckoutDeps {
  selection: PgSelectionReader;
  gateways: PaymentGateways;
  channels: PgChannelTable;
  defaults: PgPlatformDefaults;
  /** 복귀 주소의 출처(PEAKET_WEB_ORIGIN) */
  webOrigin: string;
  /** 계좌번호 암호화 키가 있는가 */
  virtualAccountReady: boolean;
  clock: Clock;
  log: PrepareCheckoutLog;
  signals: PrepareCheckoutSignals;
}

/** PrepareCheckout 답 */
export interface PrepareCheckoutAnswer {
  readonly pg: PgName;
  readonly switched: boolean;
  readonly checkout: CheckoutValues;
  readonly allowedPayMethods: readonly PayMethod[];
  /** 가상계좌를 낼 수 있을 때만 있다 */
  readonly depositDueAtMs?: number;
}

export class PrepareCheckout {
  readonly #alertGates = new Map<string, LogGate>();

  constructor(private readonly deps: PrepareCheckoutDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀림 · PaymentPgUnavailableError 고른 결제사를 쓸 수 없음 · PaymentDeadlineError·저장소 오류
   */
  async execute(input: PrepareCheckoutInput, budget?: CallBudget): Promise<PrepareCheckoutAnswer> {
    const { signals, gateways, channels, defaults, webOrigin, virtualAccountReady, clock } = this.deps;
    const command = this.#parse(input);
    const state = await this.#read(command, budget);
    const selection = selectPg({ ...state, defaults, channels, payMethod: command.payMethod, ...(command.pinnedPg === undefined ? {} : { pinnedPg: command.pinnedPg }) });
    if (selection.kind === 'UNAVAILABLE') throw this.#unavailable(selection.pg, selection.reason, command);
    const gateway = gateways.of(selection.pg);
    // 채널 표는 같은 등록부에서 만들어 비지 않는다. 비었으면 고를 수 없는 것과 같게 다룬다
    if (gateway === undefined) throw this.#unavailable(selection.pg, 'NO_CHANNEL', command);
    const nowMs = clock.now();
    const depositDueAtMs = checkoutDepositDueAtMs(nowMs, command.entryOpensAtMs);
    const allowed = allowedPayMethods(selection.channel, { virtualAccountAllowed: command.virtualAccountAllowed, virtualAccountReady, depositDueAtMs, nowMs });
    if (!allowed.includes(command.payMethod)) {
      signals.prepared('none', 'invalid');
      throw new PaymentInputError('pay_method');
    }
    const urls = checkoutReturnUrls(webOrigin, command.eventId, command.orderId, selection.pg);
    const checkout = gateway.checkout(
      { orderId: command.orderId, orderName: command.orderName, amount: command.amount, ...(command.customerKey === undefined ? {} : { customerKey: command.customerKey }) },
      { attemptId: command.attemptId, ...urls },
      command.payMethod,
    );
    signals.prepared(selection.pg, selection.switched ? 'switched' : 'ok');
    return { pg: selection.pg, switched: selection.switched, checkout, allowedPayMethods: allowed, ...(allowed.includes('VIRTUAL_ACCOUNT') ? { depositDueAtMs } : {}) };
  }

  #parse(input: PrepareCheckoutInput): PrepareCheckoutCommand {
    try {
      return parsePrepareCheckoutInput(input);
    } catch (err) {
      this.deps.signals.prepared('none', 'invalid');
      throw err;
    }
  }

  async #read(command: PrepareCheckoutCommand, budget: CallBudget | undefined): Promise<PgSelectionState> {
    try {
      return await this.deps.selection.read(command.eventId, budget);
    } catch (err) {
      this.deps.signals.prepared('none', 'error');
      throw err;
    }
  }

  /** 답은 까닭과 상관없이 pg-unavailable이다. 수단 미지원은 결제사 장애가 아니라서 SEV2 경보(pg_unavailable)와 오류 로그에 세지 않는다(BUILD_ORDER PRF-190 코드 리뷰) */
  #unavailable(pg: PgName, reason: PgUnavailableReason, { eventId, payMethod }: PrepareCheckoutCommand): PaymentPgUnavailableError {
    this.deps.signals.prepared(pg, reason === 'METHOD_UNSUPPORTED' ? 'method_unsupported' : 'pg_unavailable');
    const allowed = this.#gateOf(reason === 'METHOD_UNSUPPORTED' ? `${pg}:${reason}:${payMethod}` : `${pg}:${reason}`).allow();
    if (allowed) {
      if (reason === 'METHOD_UNSUPPORTED') this.deps.log.methodUnsupported({ pg, payMethod, eventId });
      else this.deps.log.pgUnavailable({ pg, reason, eventId });
    }
    return new PaymentPgUnavailableError();
  }

  #gateOf(key: string): LogGate {
    let gate = this.#alertGates.get(key);
    if (gate === undefined) {
      gate = new LogGate(this.deps.clock, PG_UNAVAILABLE_LOG_INTERVAL_MS);
      this.#alertGates.set(key, gate);
    }
    return gate;
  }
}
