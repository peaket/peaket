// 결제창 준비 쓰임새(docs/features/payment.md §2.2 '선택기의 첫 구현', BUILD_ORDER PRF-190). 결제사를 부르지 않는다. 쓰기는 시험 재개의 payment_entry_trial뿐이다(BUILD_ORDER PRF-202).
// 새 결제 일시 정지(BUILD_ORDER PRF-201): 고른 결제사가 정지면 PaymentNewPausedError다. 재생은 정지를 읽지 않고, 시험 재개에서 받은 주문은 다시 통과한다.
// 대체 후보 빼기(BUILD_ORDER PRF-203): 전환이 포트원을 고르면(재생은 빼고) 그 수단 채널의 관측 하위 결제사가 설정과 다르거나 실제 하위 결제사가 기준 결제사와 규칙에 걸리는지 읽어,
// 그렇다면 대체가 없을 때처럼 기준 결제사로 다시 고른다. 평소 길과 포트원이 아닌 전환 대상에는 읽기를 더하지 않는다(코드 리뷰 F1).
import type { Clock } from '@peaket/platform';
import { PaymentInputError } from '../domain/confirm-command.js';
import { admitsEntryTrial, entryTrialDraw } from '../domain/entry-pause-judge.js';
import { LogGate } from '../domain/log-gate.js';
import type { CheckoutValues, PayMethod, PgName } from '../domain/payment-gateway.js';
import { type EntryPauses, isEntryPaused, PaymentNewPausedError } from '../domain/entry-pause.js';
import { allowedPayMethods, checkoutReturnUrls, parsePrepareCheckoutInput, PaymentPgUnavailableError, type PgChannelTable, type PgPlatformDefaults, type PgSelectionState, type PgUnavailableReason, type PrepareCheckoutCommand, type PrepareCheckoutInput, selectPg } from '../domain/pg-selection.js';
import type { CallBudget, EntryPauseReader, EntryTrialSignals, EntryTrialStore, FallbackExclusionReader, PaymentGateways, PgSelectionReader, PrepareCheckoutLog, PrepareCheckoutSignals } from '../domain/ports.js';
import { checkoutDepositDueAtMs } from '../domain/virtual-account.js';

/** 결제사를 고르지 못한 경보 로그의 간격 1분 [가정](결제사·까닭마다) */
const PG_UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

export interface PrepareCheckoutDeps {
  selection: PgSelectionReader;
  /** 새 결제 일시 정지 행(파드 캐시, BUILD_ORDER PRF-201) */
  pauses: EntryPauseReader;
  /** 시험 재개로 받은 주문(BUILD_ORDER PRF-201·PRF-202) */
  trials: EntryTrialStore;
  /** 시험 재개 추첨값(0~9999)을 주문과 정지 행 판 번호로 뽑는다. 없으면 entryTrialDraw다(BUILD_ORDER PRF-202) */
  drawEntryTrial?: (orderId: string, version: number) => number;
  /** 시험 재개 지표. 없으면 세지 않는다(BUILD_ORDER PRF-202) */
  trialSignals?: EntryTrialSignals;
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
  /** 전환의 대체 후보에서 뺄 수단(포트원 채널의 하위 결제사, BUILD_ORDER PRF-203). 없으면 빼지 않는다 */
  fallbackExclusions?: FallbackExclusionReader;
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
   * @throws PaymentInputError 입력이 틀림 · PaymentPgUnavailableError 고른 결제사가 수단을 받지 않거나 재생에서 쓸 수 없음 · PaymentNewPausedError 새 결제 일시 정지(채널 없음·비활성 포함) · PaymentDeadlineError·저장소 오류
   */
  async execute(input: PrepareCheckoutInput, budget?: CallBudget): Promise<PrepareCheckoutAnswer> {
    const { signals, gateways, channels, defaults, webOrigin, virtualAccountReady, clock } = this.deps;
    const startedAtMs = clock.monotonicMs();
    const command = this.#parse(input);
    const [state, pauses] = await this.#read(command, budget);
    const selectionInput = { ...state, defaults, channels, payMethod: command.payMethod, ...(command.pinnedPg === undefined ? {} : { pinnedPg: command.pinnedPg }) };
    let selection = selectPg(selectionInput);
    const exclusions = this.deps.fallbackExclusions;
    // 빼기는 전환이 그 판단 결제사(포트원)를 고른 때만 읽는다(코드 리뷰 F1). 기준 결제사는 회차 지정 → 플랫폼 기본이다(selectPg와 같다)
    if (selection.kind === 'SELECTED' && selection.switched && command.pinnedPg === undefined && exclusions !== undefined && selection.pg === exclusions.pg) {
      const base = state.assignment?.primary ?? defaults.primary;
      const excluded = await this.#exclusions(exclusions, base, budget === undefined ? undefined : { remainingMs: budget.remainingMs - (clock.monotonicMs() - startedAtMs) });
      if (excluded.has(command.payMethod)) selection = selectPg({ ...selectionInput, fallbackExcluded: new Map([[exclusions.pg, excluded]]) });
    }
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
    // 시험 행 읽기는 앞의 읽기가 쓴 시간을 뺀 시한으로 한다(BUILD_ORDER PRF-201 코드 리뷰)
    if (pauses !== undefined) await this.#passPause(selection.pg, pauses, command, budget === undefined ? undefined : { remainingMs: budget.remainingMs - (clock.monotonicMs() - startedAtMs) });
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

  /** 재생은 정지를 읽지 않는다(처음 201을 준 요청이다). 두 읽기를 함께 돌려 호출의 시한을 두 번 쓰지 않는다 */
  async #read(command: PrepareCheckoutCommand, budget: CallBudget | undefined): Promise<[PgSelectionState, EntryPauses | undefined]> {
    try {
      return await Promise.all([this.deps.selection.read(command.eventId, budget), command.pinnedPg === undefined ? this.deps.pauses.read(budget) : undefined]);
    } catch (err) {
      this.deps.signals.prepared('none', 'error');
      throw err;
    }
  }

  /** 대체 후보에서 뺄 채널을 읽는다. 읽지 못하면 값을 지어내지 않고 실패한다(BUILD_ORDER PRF-203) */
  async #exclusions(reader: FallbackExclusionReader, base: PgName, budget: CallBudget | undefined) {
    try {
      return await reader.read(base, budget);
    } catch (err) {
      this.deps.signals.prepared('none', 'error');
      throw err;
    }
  }

  /** 고른 결제사가 정지면 던진다. 시험 재개(5% [가정])에 뽑힌 주문만 지나간다. 뽑기는 시험마다 주문별로 고정이라 떨어진 주문은 시험 행을 읽거나 쓰지 않는다(BUILD_ORDER PRF-202 코드 리뷰). 시험 행을 읽지 못하면 통과시키지 않는다 */
  async #passPause(pg: PgName, pauses: EntryPauses, { orderId }: PrepareCheckoutCommand, budget: CallBudget | undefined): Promise<void> {
    const row = pauses.get(pg);
    if (!isEntryPaused(row)) return;
    if (row.stage === 'TRIAL' && this.#drawn(orderId, pg, row.version)) {
      const startedAtMs = this.deps.clock.monotonicMs();
      let admitted: boolean;
      try {
        admitted = await this.deps.trials.isAdmitted(orderId, pg, budget);
      } catch (err) {
        this.deps.signals.prepared(pg, 'error');
        throw err;
      }
      if (admitted || (await this.#admitTrial(orderId, pg, startedAtMs, budget))) return;
    }
    this.deps.signals.prepared(pg, 'new_payment_paused');
    throw new PaymentNewPausedError();
  }

  /** 시험 재개 추첨. 떨어지면 지표를 센다 */
  #drawn(orderId: string, pg: PgName, version: number): boolean {
    const admits = admitsEntryTrial((this.deps.drawEntryTrial ?? entryTrialDraw)(orderId, version));
    if (!admits) this.deps.trialSignals?.trial(pg, 'rejected');
    return admits;
  }

  /** 뽑힌 주문의 행을 쓴다(BUILD_ORDER PRF-202). 쓰기가 실패하면 받지 않는다(받았는데 세지 못하는 일을 만들지 않는다) */
  async #admitTrial(orderId: string, pg: PgName, startedAtMs: number, budget: CallBudget | undefined): Promise<boolean> {
    const { trials, trialSignals, clock } = this.deps;
    try {
      await trials.admit(orderId, pg, clock.now(), budget === undefined ? undefined : { remainingMs: budget.remainingMs - (clock.monotonicMs() - startedAtMs) });
    } catch {
      trialSignals?.trialWriteFailed('admit');
      return false;
    }
    trialSignals?.trial(pg, 'admitted');
    return true;
  }

  /**
   * 채널 없음·비활성은 새 결제 일시 정지와 같은 답이고 수단 미지원·재생은 pg-unavailable이다(BUILD_ORDER PRF-201). 경보와 로그는 까닭을 그대로 센다.
   * 수단 미지원은 결제사 장애가 아니라서 SEV2 경보(pg_unavailable)와 오류 로그에 세지 않는다(BUILD_ORDER PRF-190 코드 리뷰)
   */
  #unavailable(pg: PgName, reason: PgUnavailableReason, { eventId, payMethod, pinnedPg }: PrepareCheckoutCommand): PaymentPgUnavailableError | PaymentNewPausedError {
    this.deps.signals.prepared(pg, reason === 'METHOD_UNSUPPORTED' ? 'method_unsupported' : 'pg_unavailable');
    const allowed = this.#gateOf(reason === 'METHOD_UNSUPPORTED' ? `${pg}:${reason}:${payMethod}` : `${pg}:${reason}`).allow();
    if (allowed) {
      if (reason === 'METHOD_UNSUPPORTED') this.deps.log.methodUnsupported({ pg, payMethod, eventId });
      else this.deps.log.pgUnavailable({ pg, reason, eventId });
    }
    return reason === 'METHOD_UNSUPPORTED' || pinnedPg !== undefined ? new PaymentPgUnavailableError() : new PaymentNewPausedError();
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
