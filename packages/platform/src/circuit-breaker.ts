// 서비스 안 2차 차단기(ADR-0009 결정 2·5, docs/api/guidelines.md §2, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 1~5).
// 의존성마다 하나. opossum 10은 상태·열림 뒤 타이머·시험 호출 하나만 맡고, 열림 판정 창·떼어 내기·시험 한도·동시 호출 상한·실패 분류·지표는 이 감싸개가 맡는다.
import { EventEmitter } from 'node:events';
import { Counter, Gauge, type Registry } from '@prometheus-io/client';
import CircuitBreakerImpl from 'opossum';
import { type Clock, systemClock } from './clock.js';
import { requestContext } from './context.js';
import type { PlatformLogger } from './log.js';
import { ProblemError, deadlineExceeded, serverBusy } from './problem.js';

/** 공용 기본값 [가정](docs/features/bot-defense.md §11의 수치. 의존성마다 Q-T58·G-15에서 잰다) */
export const CIRCUIT_BREAKER_DEFAULTS = Object.freeze({
  /** 실패율을 보는 창 */
  windowMs: 10_000,
  /** 창을 나눈 칸 수 */
  buckets: 10,
  /** 창 안의 호출이 이만큼 이상일 때만 판정한다 */
  minCalls: 20,
  /** 실패가 이 비율 이상이면 연다 */
  failureRatePercent: 50,
  /** 열린 뒤 시험 호출까지 */
  openMs: 5_000,
  /** 반 열림의 시험 호출이 이 안에 끝나지 않으면 실패로 보고 다시 연다(코드 리뷰 2026-11-01: 끝나지 않으면 반 열림에 영원히 머물렀다) */
  trialTimeoutMs: 5_000,
});

/** 열릴 때 진행 중이던 호출: opossum 판정에서 떼어 냈다(부른 쪽은 진짜 결과를 받는다) */
const DETACHED = Symbol('peaket.breaker.detached');
/** 시험 호출 한도를 넘었다(언제나 실패로 센다) */
class TrialTimeout extends Error {
  override readonly name = 'TrialTimeout';
}

export type CircuitState = 'closed' | 'half_open' | 'open';
const STATE_VALUE: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };
const DEPENDENCY = /^[a-z][a-z0-9-]{0,31}$/;

export interface CircuitBreakerOptions {
  /** 지표의 service 라벨 */
  service: string;
  /** 의존성 이름(소문자·숫자·-, 예 trust-svc·toss·portone). 지표·로그에만 싣고 응답 본문에는 싣지 않는다 */
  dependency: string;
  registry?: Registry;
  logger?: PlatformLogger;
  clock?: Clock;
  windowMs?: number;
  buckets?: number;
  minCalls?: number;
  failureRatePercent?: number;
  openMs?: number;
  /** 반 열림 시험 호출의 한도(ms) */
  trialTimeoutMs?: number;
  /** 동시 호출 상한(벌크헤드). 넘으면 부르지 않고 429 server-busy. 없으면 상한 없음(연결 분리만) */
  maxConcurrent?: number;
  /** 이 오류를 의존성 실패로 셀지(기본 isBreakerFailure) */
  isFailure?: (err: unknown) => boolean;
}

/** 실패로 세는 gRPC 상태 코드: UNKNOWN·DEADLINE_EXCEEDED·RESOURCE_EXHAUSTED·INTERNAL·UNAVAILABLE·DATA_LOSS(docs/features/payment.md §10) */
const GRPC_FAILURE_CODES = new Set([2, 4, 8, 13, 14, 15]);

function isGrpcServiceError(err: unknown): err is { code: number } {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number' && 'details' in err && 'metadata' in err;
}

/**
 * 기본 실패 분류(결정 3). Problem은 5xx·429만, gRPC는 서버 쪽 실패 코드만 실패다. 업무 거절(그 밖의 4xx·gRPC 업무 코드)은 의존성이
 * 답한 것이라 세지 않는다. 분류가 없는 오류(연결 오류, 시간 초과, 그 밖의 예외)는 실패다
 */
export function isBreakerFailure(err: unknown): boolean {
  if (err instanceof ProblemError) return err.status >= 500 || err.status === 429;
  if (isGrpcServiceError(err)) return GRPC_FAILURE_CODES.has(err.code);
  return true;
}

/** 차단기가 열려 의존성을 부르지 않았다(guidelines §2). 의존성 이름은 본문에 싣지 않는다 */
export function dependencyUnavailable(retryAfterSeconds: number, cause?: unknown): ProblemError {
  return new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds, cause });
}

const metricsByRegistry = new WeakMap<Registry, CircuitBreakerMetrics>();

/** 차단기 지표(ADR-0009 결정 5). 지표 저장소마다 한 벌이고 의존성은 라벨이다 */
export class CircuitBreakerMetrics {
  static for(registry: Registry): CircuitBreakerMetrics {
    let m = metricsByRegistry.get(registry);
    if (!m) {
      m = new CircuitBreakerMetrics(registry);
      metricsByRegistry.set(registry, m);
    }
    return m;
  }

  readonly state: Gauge<'service' | 'dependency'>;
  readonly rejected: Counter<'service' | 'dependency' | 'reason'>;
  private constructor(registry: Registry) {
    const registers = [registry];
    this.state = new Gauge({ name: 'circuit_breaker_state', help: '차단기 상태(0 닫힘, 1 반 열림, 2 열림)', labelNames: ['service', 'dependency'], registers });
    this.rejected = new Counter({
      name: 'circuit_breaker_rejected_total',
      help: '의존성을 부르지 않고 끊은 호출 수(reason: open 열려 끊음, bulkhead 동시 호출 상한)',
      labelNames: ['service', 'dependency', 'reason'],
      registers,
    });
  }
}

/** 양의 정수(다시 본 코드 리뷰 2026-11-01: 0과 1 사이 소수가 검사를 지난 뒤 0으로 잘렸다) */
const positiveInt = (v: number, what: string) => {
  if (!(Number.isSafeInteger(v) && v > 0)) throw new RangeError(`${what}는 양의 정수여야 한다: ${v}`);
  return v;
};

/** setTimeout이 받는 가장 긴 시간. 넘으면 Node가 1ms로 줄인다(다섯 번째 코드 리뷰 2026-11-01) */
const MAX_TIMER_MS = 2_147_483_647;
const timerMs = (v: number, what: string) => {
  positiveInt(v, what);
  if (v > MAX_TIMER_MS) throw new RangeError(`${what}는 ${MAX_TIMER_MS}ms 이하여야 한다: ${v}`);
  return v;
};
/** 시험이 opossum 안의 창 크기를 볼 때만 쓴다 */
const IMPL_FOR_TEST = Symbol.for('peaket.breaker.implForTest');

/** 판정 창의 한 칸(끝난 호출 수와 그 가운데 실패 수) */
interface WindowBucket {
  calls: number;
  failures: number;
}

export class CircuitBreaker {
  readonly dependency: string;
  readonly #impl: CircuitBreakerImpl<[() => Promise<unknown>], unknown>;
  /** opossum 자체 창을 돌리는 신호. 우리 창이 칸을 넘길 때 같이 돌린다(opossum은 호출마다 지연 값을 첫 칸에 쌓는다) */
  readonly #rotate = new EventEmitter();
  readonly #clock: Clock;
  readonly #bucketMs: number;
  readonly #window: WindowBucket[];
  readonly #minCalls: number;
  readonly #rate: number;
  readonly #openMs: number;
  readonly #trialTimeoutMs: number;
  readonly #maxConcurrent: number;
  readonly #isFailure: (err: unknown) => boolean;
  /** opossum이 결과를 기다리는 호출(열릴 때·끌 때 떼어 낸다) */
  readonly #tracked = new Set<() => void>();
  readonly #labels: { service: string; dependency: string };
  readonly #metrics?: CircuitBreakerMetrics;
  #current = 0;
  #bucketStart: number;
  #openedAt = 0;
  #inFlight = 0;
  #shutdown = false;

  constructor(o: CircuitBreakerOptions) {
    if (!DEPENDENCY.test(o.dependency)) throw new TypeError(`dependency는 소문자·숫자·-로 된 32자 이하여야 한다: ${o.dependency}`);
    this.dependency = o.dependency;
    this.#clock = o.clock ?? systemClock;
    const windowMs = positiveInt(o.windowMs ?? CIRCUIT_BREAKER_DEFAULTS.windowMs, 'windowMs');
    const buckets = positiveInt(o.buckets ?? CIRCUIT_BREAKER_DEFAULTS.buckets, 'buckets');
    this.#bucketMs = windowMs / buckets;
    this.#window = Array.from({ length: buckets }, () => ({ calls: 0, failures: 0 }));
    this.#openMs = timerMs(o.openMs ?? CIRCUIT_BREAKER_DEFAULTS.openMs, 'openMs');
    this.#trialTimeoutMs = timerMs(o.trialTimeoutMs ?? CIRCUIT_BREAKER_DEFAULTS.trialTimeoutMs, 'trialTimeoutMs');
    this.#minCalls = positiveInt(o.minCalls ?? CIRCUIT_BREAKER_DEFAULTS.minCalls, 'minCalls');
    const rate = o.failureRatePercent ?? CIRCUIT_BREAKER_DEFAULTS.failureRatePercent;
    if (!(Number.isFinite(rate) && rate > 0 && rate <= 100)) throw new RangeError(`failureRatePercent는 0보다 크고 100 이하여야 한다: ${rate}`);
    this.#rate = rate;
    this.#maxConcurrent = o.maxConcurrent === undefined ? Number.POSITIVE_INFINITY : positiveInt(o.maxConcurrent, 'maxConcurrent');
    this.#labels = { service: o.service, dependency: o.dependency };
    this.#bucketStart = this.#clock.monotonicMs();
    const isFailure = o.isFailure ?? isBreakerFailure;
    // 시험 한도 초과는 늘 실패, 분류 함수가 던지면 실패로 센다(다시 본 코드 리뷰 2026-11-01: opossum 안에서 던지면 결과 약속이 끝나지 않았다)
    this.#isFailure = (err) => {
      if (err instanceof TrialTimeout) return true;
      try {
        return isFailure(err);
      } catch {
        return true;
      }
    };

    // opossum은 상태(열림·반 열림·닫힘)와 열림 → 반 열림 타이머, 반 열림의 시험 호출 하나만 맡는다(결정 1).
    // 닫힌 상태의 열림 판정은 감싸개가 끝난 호출로 직접 한다: opossum은 호출 수를 시작할 때, 실패 수를 끝날 때 칸에 더해 분자와 분모가
    // 다른 호출을 셌다(네 번째 코드 리뷰 2026-11-01). 그래서 opossum의 호출 수 문턱을 닿을 수 없게 두어 닫힌 상태에서는 스스로 열지 않게 한다.
    // 반 열림의 시험 호출이 실패하면 opossum이 문턱과 관계없이 다시 연다
    this.#impl = new CircuitBreakerImpl((action: () => Promise<unknown>) => action(), {
      // 끊는 시간은 남은 시간과 호출 상한이 맡는다(guidelines §5)
      timeout: false,
      resetTimeout: this.#openMs,
      volumeThreshold: Number.MAX_SAFE_INTEGER,
      // opossum 자체 창은 판정에 쓰지 않는다. 돌리는 타이머를 두지 않으려고 우리 신호를 주고, 우리 창이 칸을 넘길 때 같이 돌린다
      // (다섯 번째 코드 리뷰 2026-11-01: 돌리지 않으면 opossum이 호출마다 쌓는 지연 값 배열이 끝없이 커졌다)
      rotateBucketController: this.#rotate,
      rollingCountBuckets: buckets,
      rollingCountTimeout: windowMs,
      // 실패마다 지연 배열을 정렬하는 비용이 크고 쓰지 않는다
      rollingPercentilesEnabled: false,
      enableSnapshots: false,
      errorFilter: (err: unknown) => !this.#isFailure(err),
    });

    this.#metrics = o.registry ? CircuitBreakerMetrics.for(o.registry) : undefined;
    this.#metrics?.state.set(this.#labels, 0);
    const changed = (state: CircuitState) => {
      this.#metrics?.state.set(this.#labels, STATE_VALUE[state]);
      o.logger?.[state === 'closed' ? 'info' : 'warn']({ kind: 'breaker', dependency: o.dependency, state }, `차단기 ${state}`);
    };
    this.#impl.on('open', () => {
      this.#openedAt = this.#clock.monotonicMs();
      // 열리기 전부터 진행 중이던 호출은 반 열림의 판정(시험 호출 하나)에 끼지 않게 떼어 낸다(코드 리뷰 2026-11-01:
      // 늦게 끝난 옛 호출의 실패가 반 열림을 다시 열거나 성공이 시험 호출 없이 닫았다)
      for (const detach of [...this.#tracked]) detach();
      changed('open');
    });
    this.#impl.on('halfOpen', () => changed('half_open'));
    this.#impl.on('close', () => {
      // 닫히면 새로 센다(시험 호출 하나로 닫았으니 그 앞의 실패로 다시 열지 않는다)
      for (const b of this.#window) {
        b.calls = 0;
        b.failures = 0;
      }
      this.#bucketStart = this.#clock.monotonicMs();
      changed('closed');
    });
  }

  /** @internal 시험용 */
  get [IMPL_FOR_TEST](): unknown {
    return this.#impl;
  }

  get state(): CircuitState {
    if (this.#impl.opened) return 'open';
    if (this.#impl.halfOpen) return 'half_open';
    return 'closed';
  }

  /** 지금 의존성을 부르고 있는 수(떼어 냈거나 시험 한도를 넘겼어도 아직 도는 호출을 센다) */
  get inFlight(): number {
    return this.#inFlight;
  }

  /**
   * 의존성 호출 하나. 끈 뒤거나 열렸으면(반 열림의 시험 호출이 나간 뒤 포함) 503 dependency-unavailable, 남은 시간이 없으면 504,
   * 동시 호출 상한을 넘으면 429 server-busy(셋 다 부르지 않음). 그 밖에는 action의 결과·오류를 그대로 돌려준다
   */
  async run<T>(action: () => Promise<T>): Promise<T> {
    // 끈 뒤에는 부르지 않는다. opossum은 끈 뒤에도 남은 호출의 실패로 상태를 열림으로 덮어써 검사 없이 부르게 됐다(세 번째 코드 리뷰 2026-11-01)
    if (this.#shutdown) throw dependencyUnavailable(1);
    const ctx = requestContext();
    if (ctx && ctx.deadline.remainingMs() <= 0) throw deadlineExceeded();
    // 열렸거나 반 열림의 시험 호출이 이미 나갔으면 opossum이 거절할 호출이다. 동시 호출 상한보다 먼저 503으로 끝낸다
    // (세 번째 코드 리뷰 2026-11-01: 상한을 먼저 보아 열린 동안에도 429가 나갔다)
    if (!this.#impl.closed && !this.#impl.pendingClose) {
      this.#metrics?.rejected.inc({ ...this.#labels, reason: 'open' });
      throw dependencyUnavailable(this.#retryAfterSeconds());
    }
    // opossum은 반 열림에서 다음 호출 하나만 들인다(이 호출이 그것인지 부르기 전에 안다: fire가 같은 차례에 표시를 끈다)
    const trial = this.#impl.halfOpen && this.#impl.pendingClose;
    // 시험 호출은 상한이 차도 하나 더 보낸다(응답 없이 멈춘 호출이 자리를 다 잡아도 회복을 알게). 그래도 상한 + 1까지다(네 번째 코드 리뷰 2026-11-01)
    if (this.#inFlight >= this.#maxConcurrent + (trial ? 1 : 0)) {
      this.#metrics?.rejected.inc({ ...this.#labels, reason: 'bulkhead' });
      throw serverBusy();
    }
    let called = false;
    let real: Promise<T> | undefined;
    try {
      const out = await this.#impl.fire(() => {
        // opossum은 이 함수를 fire 안에서 바로 부른다. 동시 호출 수는 의존성을 실제로 부를 때만 센다(다시 본 코드 리뷰 2026-11-01)
        called = true;
        this.#inFlight += 1;
        try {
          real = Promise.resolve(action());
        } catch (e) {
          this.#inFlight -= 1;
          this.#completed(this.#isFailure(e));
          throw e;
        }
        const release = () => {
          this.#inFlight -= 1;
        };
        real.then(release, release);
        return this.#track(real, trial);
      });
      return (out === DETACHED ? await real! : out) as T;
    } catch (err) {
      // 부르지 않았을 때만 opossum의 거절이다(의존성이 같은 code로 던진 오류는 그대로 돌려준다, 세·네 번째 코드 리뷰 2026-11-01)
      if (!called) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'EOPENBREAKER') {
          this.#metrics?.rejected.inc({ ...this.#labels, reason: 'open' });
          throw dependencyUnavailable(this.#retryAfterSeconds(), err);
        }
        if (code === 'ESHUTDOWN') throw dependencyUnavailable(1, err);
      }
      // 시험 한도를 넘긴 호출의 부른 쪽은 그 호출의 진짜 결과를 받는다
      if (err instanceof TrialTimeout) return await real!;
      throw err;
    }
  }

  /** 프로세스를 끝낼 때. 남은 호출은 판정에서 떼어 내고(시험 한도 타이머도 지운다) 부른 쪽은 진짜 결과를 받는다 */
  shutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    for (const detach of [...this.#tracked]) detach();
    this.#impl.shutdown();
  }

  /**
   * opossum에 넘기는 쪽 약속. 진짜 호출이 끝나면 판정 창에 넣고(닫힌 상태일 때만) 그 결과를 넘긴다.
   * 열릴 때·끌 때 떼어 내면 DETACHED로 끝나 판정에 끼지 않는다. 시험 호출은 한도를 넘으면 TrialTimeout으로 끝난다(실패로 세어 다시 연다)
   */
  #track<T>(real: Promise<T>, trial: boolean): Promise<T | typeof DETACHED> {
    return new Promise<T | typeof DETACHED>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (): boolean => {
        if (!this.#tracked.delete(detach)) return false;
        if (timer) clearTimeout(timer);
        return true;
      };
      const detach = () => {
        if (settle()) resolve(DETACHED);
      };
      this.#tracked.add(detach);
      if (trial) {
        timer = setTimeout(() => {
          if (!settle()) return;
          // opossum이 이 실패에도 지연 값을 쌓으므로 창을 민다(여섯 번째 코드 리뷰 2026-11-01)
          this.#advanceWindow();
          reject(new TrialTimeout(`시험 호출이 ${this.#trialTimeoutMs}ms 안에 끝나지 않았다`));
        }, this.#trialTimeoutMs);
        timer.unref?.();
      }
      real.then(
        (v) => {
          if (!settle()) return;
          this.#completed(false);
          resolve(v);
        },
        (e: unknown) => {
          if (!settle()) return;
          this.#completed(this.#isFailure(e));
          reject(e);
        },
      );
    });
  }

  /**
   * 끝난 호출 하나를 끝난 시각의 칸에 넣고, 닫힌 상태에서 창 안의 끝난 호출이 문턱 이상이고 실패가 비율 이상이면 연다(성공으로 닿아도).
   * 아직 끝나지 않은 호출은 분모에 넣지 않는다(네 번째 코드 리뷰 2026-11-01). 반 열림의 판정은 opossum의 시험 호출 하나가 한다
   */
  #completed(failed: boolean): void {
    this.#advanceWindow();
    if (!this.#impl.closed) return;
    const b = this.#window[this.#current]!;
    b.calls += 1;
    // 끝난 호출마다 본다(여섯 번째 코드 리뷰 2026-11-01: 실패 때만 보아 성공으로 문턱에 닿으면 열지 않았다)
    if (failed) b.failures += 1;
    let calls = 0;
    let failures = 0;
    for (const x of this.#window) {
      calls += x.calls;
      failures += x.failures;
    }
    if (calls >= this.#minCalls && failures * 100 >= this.#rate * calls) this.#impl.open();
  }

  #advanceWindow(): void {
    const now = this.#clock.monotonicMs();
    const passed = Math.floor((now - this.#bucketStart) / this.#bucketMs);
    if (passed <= 0) return;
    const n = Math.min(passed, this.#window.length);
    for (let i = 0; i < n; i += 1) {
      this.#current = (this.#current + 1) % this.#window.length;
      const b = this.#window[this.#current]!;
      b.calls = 0;
      b.failures = 0;
      this.#rotate.emit('rotate');
    }
    this.#bucketStart = passed >= this.#window.length ? now : this.#bucketStart + passed * this.#bucketMs;
  }

  #retryAfterSeconds(): number {
    if (!this.#impl.opened) return 1;
    const left = this.#openedAt + this.#openMs - this.#clock.monotonicMs();
    return Math.max(1, Math.ceil(left / 1000));
  }
}

export function createCircuitBreaker(o: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(o);
}
