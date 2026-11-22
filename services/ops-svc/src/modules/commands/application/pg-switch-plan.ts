// 명령 6 대체 결제사 전환을 보내기 직전의 갈 곳 묻기(F-02-2 OPS-310, ADR-0366 결정 5). 처음 DISPATCHED를 쓰기 전(승인·다시 하기 요청 안)에 부른다.
// payment-svc ResolvePgSwitch를 데드라인 2초 [가정]로 부르고, 실패·시간 초과·원천 없음이면 503 pg-check-unavailable을 던진다(명령에 아무것도 쓰지 않는다).
// 회차(또는 전체 범위)의 갈 결제사 승인 상한을 모르면(설정 없음) 리더 상한을 계산할 수 없어 같은 503이다(받는 쪽에 보내지 않는다).
import { pgFallbackParamsOf } from '../domain/command-params.js';
import { controlScopesOf } from '../domain/control-kinds.js';
import { missingPgRoutes, type PgSwitchRoutes } from '../domain/pg-switch.js';
import type { PgSwitchResolver } from '../domain/ports.js';
import { PG_CHECK_TIMEOUT_MS, pgCheckUnavailable } from './pg-assignment-gate.js';
import type { Command } from '../domain/command.js';

export interface PgSwitchPlannerDeps {
  /** payment-svc ResolvePgSwitch. 없으면 늘 503이다(닫힌 쪽) */
  readonly resolver?: PgSwitchResolver;
  /** 시험이 줄인다. 없으면 2초 */
  readonly timeoutMs?: number;
}

export class PgSwitchPlanner {
  constructor(private readonly deps: PgSwitchPlannerDeps = {}) {}

  /**
   * 명령 6 결제 갈래 값(저장된 params)의 회차마다 갈 곳을 묻는다.
   * @throws ProblemError 503 pg-check-unavailable(원천 없음·실패·2초 초과·승인 상한 모름)
   */
  async routes(command: Pick<Command, 'type' | 'params'>): Promise<PgSwitchRoutes> {
    const resolver = this.deps.resolver;
    if (!resolver) throw pgCheckUnavailable();
    const params = pgFallbackParamsOf(command.params);
    let routes: PgSwitchRoutes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      routes = await Promise.race([
        resolver.resolve({ eventIds: params.scope === 'EVENT' ? [...params.eventIds] : [], ...(params.toPg !== undefined ? { toPg: params.toPg } : {}) }),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('deadline-exceeded')), this.deps.timeoutMs ?? PG_CHECK_TIMEOUT_MS))),
      ]);
    } catch {
      throw pgCheckUnavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (missingPgRoutes(controlScopesOf(command), params.toPg, routes).length > 0) throw pgCheckUnavailable();
    return routes;
  }
}
