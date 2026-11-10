// 결제사 호출 보호(docs/features/payment.md §2 '결제사 호출 보호의 첫 구현', docs/verification.md §4.1 '결제사 채널 호출 상한과 연결 수', ADR-0127, BUILD_ORDER PRF-183).
// 결제사 채널마다 파드 메모리에 하나 둔다. 어댑터를 감싸지 않고 승인 실행기와 단독 조회 실행기가 쓴다(v0 모놀리스는 쓰지 않는다).
// 프레임워크·저장소·계약 패키지를 모른다(순수 값과 시계만 받는다).
// 구현에서 정한 것(정본·설계에 없다):
// - 초당 상한은 올리지 않고 소수로 둔다(올리면 파드 합이 결제사 상한을 넘는다). 묶음 크기는 200ms치이고(코드 리뷰, 임의의 1초 창이 상한을 크게 넘지 않게), 최소 1.2개다(그래야 승인이 쓸 수 있는 90%가 토큰 하나를 넘어 작은 채널에서도 승인이 나간다).
// - 나눠서 이미 1보다 작은 초당 상한을 낮출 때 1로 올리지 않는다(낮추는 쪽으로만 움직인다).
// - 낮추면 남은 토큰도 새 묶음 크기로 줄인다(낮춘 직전에 옛 묶음을 한꺼번에 내보내지 않게).
// - 첫 호출 429의 SEV2 로그와 상한 지표는 실제로 값이 바뀐 때만 낸다(몰린 429가 로그를 쏟지 않게, 이미 하한이면 내지 않는다). 429 수 지표는 429마다 센다.
// - 자리를 다 쥐었는지와 토큰이 없는지가 겹치면 까닭은 bulkhead다(토큰은 곧 차지만 자리는 호출이 끝나야 비기 때문이다).
// - 승인의 몫은 버킷의 90% [가정]이고 나머지 10%는 단독 조회가 쓴다. 조회는 버킷 전체를 쓴다(몰린 승인이 조회를 굶겨 UNKNOWN이 풀리지 않는 일을 막는다).
// - 승인 한 건의 토큰 수는 어댑터의 capabilities().confirmCallCost다(없으면 1, BUILD_ORDER HOT-140 코드 리뷰). 묶음의 최소 크기도 비용 배로 늘린다(그래야 작은 채널에서 승인 몫이 한 건 값에 닿는다).
// 낮춘 상한의 유지·전파·회복(docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복', BUILD_ORDER PRF-203):
// - 상한은 '처음 상한 × 유효 비율'이다. 유효 비율은 이 파드가 직접 낮춘 값과 표에서 읽은 값(applyShared) 가운데 낮은 쪽이고, 만료된 값은 100이다.
// - 만료는 벽시계로 잰다(표의 시각과 같은 원천). 따로 타이머를 두지 않고 상한을 쓰는 때마다 본다(그래서 주입 시계로 경계를 시험할 수 있다).
// - 쿨다운과 '낮추기 전에 나간 호출 무시'는 이 파드가 아는 마지막 낮춤으로 본다: 직접 낮춘 것은 단조 시계, 표에서 읽은 것은 벽시계(호출 시작의 벽시계 시각은 지금 벽시계 − 단조 시계로 잰 경과다).
// - 직접 낮추면 onLowered로 표에 쓸 값을 알린다(쓰기와 겨룸 판정은 표 맞추기의 일이다). 판 번호가 지금 아는 행보다 작은 행은 걸지 않는다(늦게 끝난 읽기).
import type { PgName } from './payment-gateway.js';
import { halvedRatio, isLimitLive, PG_LIMIT_FLOOR_PERCENT, PG_LIMIT_FULL_PERCENT, PG_LIMIT_HOLD_MS, PG_LOWER_COOLDOWN_MS, type PgChannelLimitRow, type PgLimitLowering } from './pg-channel-limit.js';
import { PG_CIRCUIT_TRIAL_HOLD_MS, type PgCallKind, type PgCircuit, type PgCircuits } from './pg-circuit.js';
import type { PaymentGateways, PgCallGuardLog, PgCallGuardSignals } from './ports.js';

/** 결제사 채널 전부(어댑터가 없는 채널까지 틱이 본다) */
export const PG_NAMES: readonly PgName[] = Object.freeze(['TOSS', 'PORTONE', 'SIMULATOR'] as const);
/** 채널의 동시 승인 호출 상한(채널 추정 상한 × 2초 [가정]: 토스 600건, 포트원 100건. 시뮬레이터는 토스와 같게 600건 [가정]). 파드 수로 나눠 건다 */
export const PG_CHANNEL_BULKHEAD: Readonly<Record<PgName, number>> = Object.freeze({ TOSS: 600, PORTONE: 100, SIMULATOR: 600 });
// 한 번 낮춘 뒤 다시 낮추지 않는 시간과 낮추기 하한(값은 pg-channel-limit.ts, 파드 사이에도 같다)
export { PG_LIMIT_FLOOR_PERCENT, PG_LOWER_COOLDOWN_MS };
/** 결제사 HTTP 연결 시간 초과 3초 [가정] */
export const PG_CONNECT_TIMEOUT_MS = 3_000;
/** 토큰 묶음 크기 200ms치 [가정](임의의 1초 창의 호출을 초당 상한의 1.2배 안으로 묶는다) */
export const PG_TOKEN_BURST_MS = 200;
/** 묶음의 최소 크기(승인 몫 90%가 토큰 하나를 넘게) */
export const PG_MIN_TOKEN_BURST = 1.2;
/** 승인이 쓰지 못하는 버킷의 몫 10% [가정](단독 조회 몫) */
export const PG_QUERY_TOKEN_SHARE_PERCENT = 10;
/** payment_pg_saturated_total{reason}의 값 */
export const PG_SATURATION_REASONS = ['token', 'bulkhead'] as const;
export type PgSaturationReason = (typeof PG_SATURATION_REASONS)[number];
/** payment_pg_limit{kind}의 값 */
export const PG_LIMIT_KINDS = ['rps', 'concurrency'] as const;
export type PgLimitKind = (typeof PG_LIMIT_KINDS)[number];

/** 토큰·쿨다운은 단조 시계로 잰다(벽시계가 뒤로 가도 토큰 계산이 틀어지지 않게) */
export interface MonotonicClock {
  monotonicMs(): number;
}

/** 보호기의 시계. 낮춘 상한의 만료와 표의 낮춘 시각은 벽시계로 잰다(BUILD_ORDER PRF-203) */
export interface PgCallGuardClock extends MonotonicClock {
  now(): number;
}

const isPositiveInt = (v: number): boolean => Number.isSafeInteger(v) && v >= 1;

function assertPodCount(podCount: number): void {
  if (!isPositiveInt(podCount)) throw new RangeError(`파드 수는 1 이상의 정수다: ${String(podCount)}`);
}

/**
 * 파드당 초당 상한 = 채널 초당 상한 ÷ 파드 수(올리지 않는다).
 * @throws RangeError callsPerSecond가 양수가 아님, podCount가 1 이상의 정수가 아님
 */
export function perPodRate(callsPerSecond: number, podCount: number): number {
  if (!(Number.isFinite(callsPerSecond) && callsPerSecond > 0)) throw new RangeError(`초당 상한은 양수다: ${String(callsPerSecond)}`);
  assertPodCount(podCount);
  return callsPerSecond / podCount;
}

/**
 * 파드당 동시 승인 호출 상한 = 채널 상한 ÷ 파드 수를 올림, 최소 1.
 * @throws RangeError channelBulkhead가 1 이상의 정수가 아님, podCount가 1 이상의 정수가 아님
 */
export function perPodBulkhead(channelBulkhead: number, podCount: number): number {
  if (!isPositiveInt(channelBulkhead)) throw new RangeError(`동시 호출 상한은 1 이상의 정수다: ${String(channelBulkhead)}`);
  assertPodCount(podCount);
  return Math.max(1, Math.ceil(channelBulkhead / podCount));
}

export interface PgCallGuardOptions {
  readonly pg: PgName;
  /** capabilities().callsPerSecond(채널 전체) */
  readonly callsPerSecond: number;
  /** 채널의 동시 승인 호출 상한(나누기 전) */
  readonly channelBulkhead: number;
  readonly podCount: number;
  readonly clock: PgCallGuardClock;
  readonly signals: PgCallGuardSignals;
  readonly log: PgCallGuardLog;
  /** 직접 낮췄을 때 표에 쓸 값을 받는다(표 맞추기, BUILD_ORDER PRF-203). 던져도 낮추기를 막지 않는다 */
  readonly onLowered?: (e: PgLimitLowering) => void;
  /** capabilities().confirmCallCost(승인 한 건의 토큰 수). 없으면 1 */
  readonly confirmCallCost?: number;
  /** 채널 서킷(BUILD_ORDER PRF-200). 없으면 서킷 없이 부른다 */
  readonly circuit?: PgCircuit;
}

/** 채널 하나의 호출 보호기. 던지지 않는다(지표·로그가 던져도 삼킨다) */
export class PgCallGuard {
  readonly pg: PgName;
  readonly #clock: PgCallGuardClock;
  readonly #signals: PgCallGuardSignals;
  readonly #log: PgCallGuardLog;
  readonly #onLowered: ((e: PgLimitLowering) => void) | undefined;
  /** 승인 한 건의 토큰 수 */
  readonly #confirmCost: number;
  /** 처음 상한(파드당) */
  readonly #initialRps: number;
  readonly #initialConcurrency: number;
  #rps: number;
  #concurrency: number;
  /** 지금 건 유효 비율(퍼센트) */
  #ratio = PG_LIMIT_FULL_PERCENT;
  /** 이 파드가 직접 낮춘 값(단조 시계의 낮춘 시각, 벽시계의 낮춘 시각과 만료) */
  #local: { readonly ratio: number; readonly atMonoMs: number; readonly atMs: number; readonly expiresAtMs: number } | undefined;
  /** 표에서 마지막으로 건 행 */
  #shared: PgChannelLimitRow | undefined;
  /** 낮추기 하한 */
  readonly #rpsFloor: number;
  readonly #concurrencyFloor: number;
  #tokens: number;
  #refilledAtMs: number;
  /** 쥔 자리 수(호출과 그 뒤 쓰기, 잡기 전에 미리 쥔 것 포함) */
  #held = 0;
  /** 돌고 있는 승인 호출 수(지표) */
  #inflight = 0;
  readonly #circuit: PgCircuit | undefined;
  /** 반 열림의 시험 호출을 잡은 뒤 다음 틱이 또 잡지 않는 끝 시각(단조, 없으면 0) */
  #trialHoldUntilMs = 0;

  /** @throws RangeError 초당 상한·파드 수·벌크헤드가 틀림, confirmCallCost가 1 이상의 정수가 아님 */
  constructor(o: PgCallGuardOptions) {
    if (o.confirmCallCost !== undefined && !isPositiveInt(o.confirmCallCost)) throw new RangeError(`승인 호출 비용은 1 이상의 정수다: ${String(o.confirmCallCost)}`);
    this.pg = o.pg;
    this.#circuit = o.circuit;
    this.#clock = o.clock;
    this.#signals = o.signals;
    this.#log = o.log;
    this.#onLowered = o.onLowered;
    this.#confirmCost = o.confirmCallCost ?? 1;
    this.#initialRps = perPodRate(o.callsPerSecond, o.podCount);
    this.#initialConcurrency = perPodBulkhead(o.channelBulkhead, o.podCount);
    this.#rps = this.#initialRps;
    this.#concurrency = this.#initialConcurrency;
    // 처음 상한의 25%, 최소 1(나눠서 이미 1보다 작은 값은 그 값이 하한이다)
    this.#rpsFloor = Math.max((this.#rps * PG_LIMIT_FLOOR_PERCENT) / 100, Math.min(1, this.#rps));
    this.#concurrencyFloor = Math.max(1, Math.ceil((this.#concurrency * PG_LIMIT_FLOOR_PERCENT) / 100));
    this.#tokens = this.#burst();
    this.#refilledAtMs = o.clock.monotonicMs();
    this.#publishLimits();
  }

  /** 지금 상한(파드당). 만료된 낮춤은 여기서 처음 상한으로 돌아간다 */
  limits(): { readonly rps: number; readonly concurrency: number } {
    this.#refill();
    return { rps: this.#rps, concurrency: this.#concurrency };
  }

  /** 지금 유효 비율(퍼센트, 처음은 100) */
  ratioPercent(): number {
    this.#refill();
    return this.#ratio;
  }

  /** 표에서 마지막으로 건 행(낮출 때 판 번호 조건으로 쓴다). 없으면 undefined */
  sharedRow(): PgChannelLimitRow | undefined {
    return this.#shared;
  }

  /**
   * 표에서 읽은 이 결제사의 행을 건다(없으면 undefined). 다른 결제사의 행과 판 번호가 지금 아는 행보다 작은 행은 걸지 않는다(늦게 끝난 읽기가 옛 판을 가져온 것이다).
   * 만료된 행도 기억은 한다(다음 낮춤의 판 번호 조건). 유효 비율에는 넣지 않는다
   */
  applyShared(row: PgChannelLimitRow | undefined): void {
    if (row !== undefined && (row.pg !== this.pg || (this.#shared !== undefined && row.version < this.#shared.version))) return;
    this.#shared = row;
    this.#refill();
  }

  /** 서킷이 닫혀 있는가(서킷이 없으면 참이다). 승인과 취소는 닫혔을 때만 부른다(승인은 CONFIRM_SENT를 쓰기 전에 본다, BUILD_ORDER PRF-200, 코드 리뷰) */
  circuitClosed(): boolean {
    return this.#circuit === undefined || this.#circuit.state() === 'closed';
  }

  /** 서킷이 지금 단독 조회를 받는가(닫힘, 또는 시험 호출이 아직 나가지 않은 반 열림. 서킷이 없으면 참이다) */
  admitsQuery(): boolean {
    return this.#circuit === undefined || this.#circuit.admits();
  }

  /** 이 채널의 서킷을 한 번 닫는다(사람이 푼 해제를 이 파드가 봤을 때, 서킷이 없으면 아무것도 하지 않는다, BUILD_ORDER PRF-202 코드 리뷰) */
  closeCircuit(): void {
    this.#circuit?.close();
  }

  /** 반 열림이 시험 호출을 기다리는가(막는 시간이 지났고 아직 나가지 않았다). 잡을 UNKNOWN이 없을 때 없는 결제 조회를 보낼지 본다 */
  awaitsTrial(): boolean {
    return this.#circuit?.state() === 'half_open' && this.#queryRoom() > 0;
  }

  /**
   * 결제사 호출 하나를 서킷 안에서 돈다(kind의 뜻은 PgCallKind). 서킷이 없으면 그대로 부른다. 판정에 세는 호출에서 isOutage가 참인 답은 일시 장애로 세되 답을 그대로 돌려준다.
   * @throws PgCircuitOpenError 서킷이 끊어 부르지 않았다
   */
  run<T>(action: () => Promise<T>, isOutage: (answer: T) => boolean, kind: PgCallKind): Promise<T> {
    return this.#circuit === undefined ? action() : this.#circuit.run(action, isOutage, kind);
  }

  /** 승인이 지금 잡을 수 있는 수 = min(벌크헤드 빈자리, 조회 몫을 뺀 토큰으로 낼 수 있는 승인 건수). 서킷이 닫혀 있지 않으면 0이다(시험 호출은 단독 조회다) */
  available(): number {
    if (!this.circuitClosed()) return 0;
    this.#refill();
    return Math.min(this.#freeSlots(), this.#confirmsByTokens());
  }

  /** 여유만큼 벌크헤드 자리와 토큰(건수 × 승인 호출 비용)을 미리 쥐고 쥔 건수를 돌려준다. 쓰지 않은 만큼 release·refundConfirmTokens로 돌려준다. 0이어도 까닭을 세지 않는다(대기 행을 확인한 뒤 noteBlocked) */
  reserve(): number {
    const n = this.available();
    this.#held += n;
    this.#tokens -= n * this.#confirmCost;
    return n;
  }

  /** 상한에 막혀 표의 행을 잡지 못했다(지표). reason을 주지 않으면 자리가 없을 때 bulkhead, 아니면 token이다. 서킷이 닫혀 있지 않을 때는 상한 때문이 아니라 세지 않는다 */
  noteBlocked(reason: PgSaturationReason = this.#freeSlots() === 0 ? 'bulkhead' : 'token'): void {
    if (!this.circuitClosed()) return;
    this.#saturated(reason);
  }

  /** 자리 하나를 상한과 상관없이 쥔다(이미 잡은 행을 바로 돌릴 때) */
  holdOne(): void {
    this.#held += 1;
  }

  /** 쥔 자리를 놓는다 */
  release(count = 1): void {
    this.#held = Math.max(0, this.#held - count);
  }

  /** 토큰 하나를 쓴다(버킷 전체에서). 없으면 false이고 지표 token을 센다. 단독 조회 실행기가 틱 없이 바로 돌리는 행이 쓴다 */
  tryTakeToken(): boolean {
    return this.#tryTake(1);
  }

  /** 승인 한 건 몫의 토큰(승인 호출 비용)을 쓴다. 모자라면 쓰지 않고 false이고 지표 token을 센다. 승인 실행기가 틱 없이 바로 돌리는 행이 쓴다 */
  tryTakeConfirmTokens(): boolean {
    return this.#tryTake(this.#confirmCost);
  }

  /** 단독 조회가 쓸 토큰을 max까지 미리 빼고 뺀 수를 돌려준다(버킷 전체에서, 쓰지 않은 만큼 refundTokens로 돌려준다) */
  takeQueryTokens(max: number): number {
    this.#refill();
    const n = Math.max(0, Math.min(max, Math.floor(this.#tokens), this.#queryRoom()));
    this.#tokens -= n;
    return n;
  }

  /** 단독 조회 틱이 count건을 실제로 잡았다: 반 열림이면 잡은 뒤 부르기까지의 틈에 다음 틱이 또 잡지 않게 잠시 막는다. 잡을 행이 없으면(count 0) 막지 않는다(코드 리뷰) */
  noteTrialClaimed(count: number): void {
    if (count > 0 && this.#circuit?.state() === 'half_open') this.#trialHoldUntilMs = this.#clock.monotonicMs() + PG_CIRCUIT_TRIAL_HOLD_MS;
  }

  /** 미리 뺐지만 호출하지 않은 토큰을 돌려준다(묶음 크기를 넘지 않는다) */
  refundTokens(count = 1): void {
    this.#refill();
    this.#tokens = Math.min(this.#burst(), this.#tokens + count);
  }

  /** 미리 뺐지만 호출하지 않은 승인 건수의 토큰(건수 × 승인 호출 비용)을 돌려준다 */
  refundConfirmTokens(count = 1): void {
    this.refundTokens(count * this.#confirmCost);
  }

  /** 승인 호출을 시작했다(payment_pg_inflight) */
  callStarted(): void {
    this.#inflight += 1;
    this.#publishInflight();
  }

  /** 승인 호출이 끝났다(payment_pg_inflight) */
  callFinished(): void {
    this.#inflight = Math.max(0, this.#inflight - 1);
    this.#publishInflight();
  }

  /**
   * 결제사가 429를 줬다. 429 수 지표는 늘 센다. first가 참이고(그 명령의 첫 승인 호출) 최근 5초 안에 낮춘 적이 없고 그 호출이 마지막으로 낮춘 뒤에 나갔으면 초당 상한과 벌크헤드를 절반으로(하한은 처음 값의 25%, 최소 1) 낮추고 SEV2 로그를 낸다.
   * 이미 하한이면 아무것도 바꾸지 않고 로그·상한 지표를 내지 않는다.
   * @param o.startedAtMs 그 호출을 시작한 단조 시각. 없으면 낮춘 시각과 견주지 않는다
   * @returns 이번에 낮췄으면 true
   */
  noteThrottled(o: { readonly first: boolean; readonly startedAtMs?: number }): boolean {
    this.#safe(() => this.#signals.throttled(this.pg, o.first));
    if (!o.first) return false;
    const nowMono = this.#clock.monotonicMs();
    const nowMs = this.#clock.now();
    const local = this.#local;
    if (local !== undefined) {
      if (nowMono - local.atMonoMs < PG_LOWER_COOLDOWN_MS) return false;
      // 낮추기 전에 나간 호출의 429는 옛 상한의 결과다(이미 그 상한을 낮췄다)
      if (o.startedAtMs !== undefined && o.startedAtMs < local.atMonoMs) return false;
    }
    // 호출을 시작한 벽시계 시각(다른 파드가 표에 쓴 낮춘 시각과 견준다, BUILD_ORDER PRF-203)
    const callStartedAtMs = o.startedAtMs === undefined ? undefined : nowMs - Math.max(0, nowMono - o.startedAtMs);
    const shared = this.#shared;
    if (shared !== undefined && isLimitLive(shared, nowMs)) {
      if (nowMs - shared.loweredAtMs < PG_LOWER_COOLDOWN_MS) return false;
      if (callStartedAtMs !== undefined && callStartedAtMs < shared.loweredAtMs) return false;
    }
    // 먼저 지금까지 찬 토큰을 옛 속도로 셈한다(낮춘 뒤의 시간만 새 속도로 찬다). 만료된 낮춤도 여기서 걷힌다
    this.#refill();
    const ratio = halvedRatio(this.#ratio);
    const next = this.#limitsAt(ratio);
    if (next.rps === this.#rps && next.concurrency === this.#concurrency) return false;
    this.#local = { ratio, atMonoMs: nowMono, atMs: nowMs, expiresAtMs: nowMs + PG_LIMIT_HOLD_MS };
    this.#apply(ratio);
    this.#safe(() => this.#log.throttledFirst({ pg: this.pg, rps: next.rps, concurrency: next.concurrency }));
    const lowering: PgLimitLowering = { pg: this.pg, ratioPercent: ratio, loweredAtMs: nowMs, expiresAtMs: nowMs + PG_LIMIT_HOLD_MS, ...(callStartedAtMs === undefined ? {} : { callStartedAtMs }), ...(shared === undefined ? {} : { basis: shared }) };
    this.#safe(() => this.#onLowered?.(lowering));
    return true;
  }

  // ---- 안쪽 ----

  /** 서킷이 지금 받는 단독 조회 수: 닫힘(또는 서킷 없음)은 제한 없음, 열림은 0, 반 열림은 시험 호출이 남았으면 하나(행을 잡은 뒤 부르기까지의 틈은 PG_CIRCUIT_TRIAL_HOLD_MS 막는다) */
  #queryRoom(): number {
    const c = this.#circuit;
    if (c === undefined || c.state() === 'closed') return Number.POSITIVE_INFINITY;
    if (!c.admits()) return 0;
    return this.#clock.monotonicMs() < this.#trialHoldUntilMs ? 0 : 1;
  }

  #burst(): number {
    return Math.max(PG_MIN_TOKEN_BURST * this.#confirmCost, (this.#rps * PG_TOKEN_BURST_MS) / 1000);
  }

  #freeSlots(): number {
    return Math.max(0, this.#concurrency - this.#held);
  }

  /** 승인 토큰으로 낼 수 있는 건수(버킷의 마지막 10%는 조회 몫이고, 한 건은 승인 호출 비용만큼 쓴다) */
  #confirmsByTokens(): number {
    return Math.max(0, Math.floor((this.#tokens - (this.#burst() * PG_QUERY_TOKEN_SHARE_PERCENT) / 100) / this.#confirmCost));
  }

  #tryTake(cost: number): boolean {
    this.#refill();
    if (this.#tokens < cost) {
      this.#saturated('token');
      return false;
    }
    this.#tokens -= cost;
    return true;
  }

  /** 지금까지 찬 토큰을 지금 속도로 셈하고, 유효 비율이 바뀌었으면(만료·표 값) 상한을 다시 건다 */
  #refill(): void {
    const now = this.#clock.monotonicMs();
    const elapsedMs = Math.max(0, now - this.#refilledAtMs);
    this.#refilledAtMs = now;
    this.#tokens = Math.min(this.#burst(), this.#tokens + (elapsedMs / 1000) * this.#rps);
    const ratio = this.#effectiveRatio(this.#clock.now());
    if (ratio === this.#ratio) return;
    this.#apply(ratio);
    if (ratio === PG_LIMIT_FULL_PERCENT) this.#safe(() => this.#log.limitRestored?.({ pg: this.pg, rps: this.#rps, concurrency: this.#concurrency }));
  }

  /** 파드 안 값과 표 값 가운데 낮은 쪽(만료된 값은 100) */
  #effectiveRatio(nowMs: number): number {
    const local = this.#local !== undefined && isLimitLive(this.#local, nowMs) ? this.#local.ratio : PG_LIMIT_FULL_PERCENT;
    const shared = this.#shared !== undefined && isLimitLive(this.#shared, nowMs) ? this.#shared.ratioPercent : PG_LIMIT_FULL_PERCENT;
    return Math.min(local, shared);
  }

  /** 그 비율의 상한(하한 아래로 가지 않는다) */
  #limitsAt(ratio: number): { readonly rps: number; readonly concurrency: number } {
    return {
      rps: Math.max(this.#rpsFloor, (this.#initialRps * ratio) / PG_LIMIT_FULL_PERCENT),
      concurrency: Math.max(this.#concurrencyFloor, Math.floor((this.#initialConcurrency * ratio) / PG_LIMIT_FULL_PERCENT)),
    };
  }

  /** 비율을 걸고 상한을 바꾼다. 낮추면 남은 토큰도 새 묶음 크기로 줄인다(낮춘 직전에 옛 묶음을 한꺼번에 내보내지 않게) */
  #apply(ratio: number): void {
    const { rps, concurrency } = this.#limitsAt(ratio);
    this.#ratio = ratio;
    this.#rps = rps;
    this.#concurrency = concurrency;
    this.#tokens = Math.min(this.#tokens, this.#burst());
    this.#publishLimits();
  }

  #publishLimits(): void {
    this.#safe(() => this.#signals.limit(this.pg, 'rps', this.#rps));
    this.#safe(() => this.#signals.limit(this.pg, 'concurrency', this.#concurrency));
    this.#safe(() => this.#signals.ratio?.(this.pg, this.#ratio));
  }

  #publishInflight(): void {
    this.#safe(() => this.#signals.inflight(this.pg, this.#inflight));
  }

  #saturated(reason: PgSaturationReason): void {
    this.#safe(() => this.#signals.saturated(this.pg, reason));
  }

  /** 지표·로그는 던지지 않기로 했지만, 던져도 호출 보호를 막지 않는다 */
  #safe(f: () => void): void {
    try {
      f();
    } catch {
      // 삼킨다
    }
  }
}

export interface PgCallGuardsOptions {
  readonly gateways: PaymentGateways;
  /** PEAKET_PAYMENT_POD_COUNT */
  readonly podCount: number;
  readonly clock: PgCallGuardClock;
  readonly signals: PgCallGuardSignals;
  readonly log: PgCallGuardLog;
  /** 낮춘 상한을 표에 쓰는 쪽(표 맞추기, BUILD_ORDER PRF-203). 없으면 이 파드 안에만 둔다 */
  readonly share?: { lowered(e: PgLimitLowering): void };
  /** 채널 벌크헤드를 바꾼다(시험용. 기본 PG_CHANNEL_BULKHEAD) */
  readonly bulkheads?: Partial<Record<PgName, number>>;
  /** 채널별 서킷(BUILD_ORDER PRF-200). 없으면 서킷 없이 부른다 */
  readonly circuits?: PgCircuits;
}

/** 채널별 보호기 등록부. 어댑터의 capabilities를 처음 부를 때 읽어 만들고 파드가 살아 있는 동안 같은 것을 돌려준다 */
export class PgCallGuards {
  readonly #byPg = new Map<PgName, PgCallGuard>();

  constructor(readonly o: PgCallGuardsOptions) {}

  /**
   * 그 채널의 보호기. 어댑터가 없으면 undefined.
   * @throws 어댑터 등록부나 capabilities()가 던지면 그대로 던진다(캐시하지 않아 다음에 다시 만든다)
   */
  of(pg: PgName): PgCallGuard | undefined {
    const known = this.#byPg.get(pg);
    if (known !== undefined) return known;
    const gateway = this.o.gateways.of(pg);
    if (gateway === undefined) return undefined;
    const { callsPerSecond, confirmCallCost } = gateway.capabilities();
    const circuit = this.o.circuits?.of(pg);
    const guard = new PgCallGuard({
      pg,
      callsPerSecond,
      ...(confirmCallCost === undefined ? {} : { confirmCallCost }),
      ...(circuit === undefined ? {} : { circuit }),
      channelBulkhead: this.o.bulkheads?.[pg] ?? PG_CHANNEL_BULKHEAD[pg],
      podCount: this.o.podCount,
      clock: this.o.clock,
      signals: this.o.signals,
      log: this.o.log,
      onLowered: (e) => this.o.share?.lowered(e),
    });
    this.#byPg.set(pg, guard);
    return guard;
  }
}
