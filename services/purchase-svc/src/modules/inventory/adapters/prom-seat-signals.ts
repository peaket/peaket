// 좌석 Lua·만료 반복 지표(BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 4'·추천 적용 2026-11-04 M1, 경보 행은 docs/observability.md).
// 이름표는 값이 몇 개뿐인 것만 단다(observability §8). queue-svc adapters/prom-admission-signals.ts와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { SweepOutcome } from '../domain/expiry.js';
import type { SeatLuaErrorCode, SeatLuaScript } from '../domain/lua-errors.js';
import type { SeatSignals } from '../domain/ports.js';

/**
 * SeatSignals의 Prometheus 구현. 이름표에 회차 ID·계정 ID·키 이름을 달지 않는다.
 * - seat_lua_errors_total{script, code}(카운터, script는 SeatLuaScript, code는 SeatLuaErrorCode의 값만)
 * - seat_expiry_lag_seconds(게이지, 이름표 없음): 이 파드가 마지막 틱에 돈 회차 가운데 지금 − 가장 오래된 지난 점수(초)의 최댓값, 밀린 것이 없으면 0(M1)
 * - seat_expiry_ticks_total{outcome}(카운터, outcome은 SweepOutcome의 값만): 회차의 틱 결과마다 1(M1)
 */
export class PromSeatSignals implements SeatSignals {
  readonly #luaErrors = new Counter({
    name: 'seat_lua_errors_total',
    help: '좌석 Lua 오류·NOT_READY 수(script: hold·expire, code: CORRUPT_KEY·KEEP_UNTIL_PAST·FENCE_OVERFLOW·OOM·NOT_READY·OTHER)',
    labelNames: ['script', 'code'] as const,
    registers: [],
  });
  readonly #lag = new Gauge({ name: 'seat_expiry_lag_seconds', help: '이 파드가 돈 회차 가운데 지금 − 가장 오래된 지난 만료 점수(초). 밀린 것이 없으면 0', registers: [] });
  readonly #ticks = new Counter({ name: 'seat_expiry_ticks_total', help: '만료 반복의 회차별 틱 결과 수', labelNames: ['outcome'] as const, registers: [] });

  /** 지표를 registry에 붙이고 자신을 돌려준다(main.ts가 service.metrics.registry로 한 번 부른다) */
  register(registry: Registry): this {
    for (const m of [this.#luaErrors, this.#lag, this.#ticks]) registry.registerMetric(m);
    return this;
  }

  /** seat_lua_errors_total{script, code}를 1 올린다. 던지지 않는다(붙이기 전에도 센다) */
  luaError(script: SeatLuaScript, code: SeatLuaErrorCode): void {
    this.#luaErrors.inc({ script, code });
  }

  /** seat_expiry_lag_seconds를 seconds(0 이상)로 둔다 */
  expiryLag(seconds: number): void {
    this.#lag.set(Math.max(0, seconds));
  }

  /** seat_expiry_ticks_total{outcome}을 1 올린다 */
  expiryTick(outcome: SweepOutcome): void {
    this.#ticks.inc({ outcome });
  }
}
