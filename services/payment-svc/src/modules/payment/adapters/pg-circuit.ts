// 결제사 서킷의 차단기 어댑터(docs/features/payment.md §2 '결제사 서킷의 첫 구현', ADR-0009 결정 2, BUILD_ORDER PRF-200).
// 차단기는 packages/platform circuit-breaker이고 값은 그 기본값이다(창 10초, 끝난 호출 20건 이상·실패 50% 이상이면 열고 5초 뒤 시험 호출 하나, 판정 한도 5초 [가정]).
// 구현에서 정한 것(정본·설계에 없다):
// - 어댑터는 일시 장애를 던지지 않고 답의 outage 표시로 알린다. 차단기는 던진 것으로만 세므로 표시 답을 안에서 던지고 밖에서 답으로 되돌린다(답을 부른 쪽에 그대로 준다).
// - 차단기가 시험 호출 뒤 다시 거절해도(같은 차례에 둘이 들어와 opossum이 하나만 들인 때) PgCircuitOpenError로 바꾼다.
// - 닫힌 서킷의 단독 조회는 차단기를 거치지 않고 바로 부른다(차단기는 지나간 호출을 모두 판정 창에 넣는다. 열림 판정은 승인의 실패율로만 한다, 코드 리뷰). 반 열림의 승인은 부르지 않는다(시험 호출은 단독 조회다).
import { type CircuitBreaker, type Clock, createCircuitBreaker, Gauge, type PlatformLogger, PROBLEM_TYPE_BASE, ProblemError, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import { PG_NAMES } from '../domain/pg-call-guard.js';
import { type PgCallKind, PgCircuitOpenError, type PgCircuit, type PgCircuits, type PgCircuitState } from '../domain/pg-circuit.js';

export interface BreakerPgCircuitsOptions {
  /** 지표의 service 라벨 */
  readonly service: string;
  /** 없으면 차단기 지표를 붙이지 않는다 */
  readonly registry?: Registry;
  readonly logger?: PlatformLogger;
  readonly clock?: Clock;
  /** 시험용: 채널의 차단기 값을 바꾼다(기본은 플랫폼 기본값) */
  readonly overrides?: { readonly minCalls?: number; readonly failureRatePercent?: number; readonly openMs?: number; readonly trialTimeoutMs?: number; readonly windowMs?: number };
}

/** 차단기 안에서 던지는 일시 장애 답(밖에서 답으로 되돌린다) */
class OutageAnswer<T> extends Error {
  override readonly name = 'PgOutageAnswer';
  constructor(readonly answer: T) {
    super('결제사 일시 장애');
  }
}

/** 채널 하나의 서킷(차단기 하나를 감싼다) */
export class BreakerPgCircuit implements PgCircuit {
  readonly #breaker: CircuitBreaker;

  constructor(readonly pg: PgName, readonly o: BreakerPgCircuitsOptions) {
    this.#breaker = createCircuitBreaker({
      service: o.service,
      dependency: pg.toLowerCase(),
      ...(o.registry === undefined ? {} : { registry: o.registry }),
      ...(o.logger === undefined ? {} : { logger: o.logger }),
      ...(o.clock === undefined ? {} : { clock: o.clock }),
      ...o.overrides,
    });
  }

  state(): PgCircuitState {
    return this.#breaker.state;
  }

  admits(): boolean {
    return this.#breaker.acceptsCalls;
  }

  async run<T>(action: () => Promise<T>, isOutage: (answer: T) => boolean, kind: PgCallKind): Promise<T> {
    const closed = this.#breaker.state === 'closed';
    if (kind === 'confirm' && !closed) throw new PgCircuitOpenError();
    if (kind === 'query' && closed) {
      if (!this.admits()) throw new PgCircuitOpenError();
      return action();
    }
    try {
      return await this.#breaker.run(async () => {
        const answer = await action();
        if (isOutage(answer)) throw new OutageAnswer(answer);
        return answer;
      });
    } catch (err) {
      if (err instanceof OutageAnswer) return err.answer as T;
      if (err instanceof ProblemError && err.type === `${PROBLEM_TYPE_BASE}dependency-unavailable`) throw new PgCircuitOpenError();
      throw err;
    }
  }

  shutdown(): void {
    this.#breaker.shutdown();
  }
}

/** 채널별 서킷 등록부. 처음 부를 때 만들고 파드가 살아 있는 동안 같은 것을 돌려준다 */
export class BreakerPgCircuits implements PgCircuits {
  readonly #byPg = new Map<PgName, BreakerPgCircuit>();

  constructor(readonly o: BreakerPgCircuitsOptions) {}

  of(pg: PgName): BreakerPgCircuit {
    let circuit = this.#byPg.get(pg);
    if (circuit === undefined) {
      circuit = new BreakerPgCircuit(pg, this.o);
      this.#byPg.set(pg, circuit);
    }
    return circuit;
  }

  /** 서킷 상태 지표 payment_pg_circuit_open{pg}를 registry에 붙이고 자신을 돌려준다(수집 때 차단기를 읽는다, 1이면 열림·반 열림. 파드 라벨은 수집기가 붙인다) */
  register(registry: Registry): this {
    const byPg = this.#byPg;
    const gauge = new Gauge({
      name: 'payment_pg_circuit_open',
      help: '결제사 서킷이 닫혀 있지 않은가(1 열림·반 열림, 0 닫힘)',
      labelNames: ['pg'] as const,
      registers: [],
      collect() {
        for (const pg of PG_NAMES) this.set({ pg }, byPg.get(pg)?.state() === undefined || byPg.get(pg)!.state() === 'closed' ? 0 : 1);
      },
    });
    registry.registerMetric(gauge);
    return this;
  }

  shutdown(): void {
    for (const circuit of this.#byPg.values()) circuit.shutdown();
  }
}
