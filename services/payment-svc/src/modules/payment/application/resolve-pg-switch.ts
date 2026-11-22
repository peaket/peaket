// 명령 6 대체 결제사 전환의 갈 곳 묻기(gRPC ResolvePgSwitch, F-02-2 OPS-310, ADR-0366 결정 5). 부르는 쪽은 ops-svc뿐이고 아무것도 쓰지 않는다.
// 회차마다 '전환이 켜졌을 때 그 회차의 새 결제 시도가 갈 결제사'를 선택기와 같은 규칙(pgSwitchTargetOf → basePgOf)으로 정하고,
// 그 결제사의 승인 상한(설정 PEAKET_PG_APPROVAL_TPS, 없으면 0)을 싣는다. 회차 지정은 캐시를 거치지 않는 일반 풀의 한 문장으로 읽는다.
import { isLowerUuid, PaymentInputError } from '../domain/confirm-command.js';
import type { PgName } from '../domain/payment-gateway.js';
import type { PgPlatformDefaults } from '../domain/pg-selection.js';
import { PG_SWITCH_TARGETS, pgSwitchTargetOf, RESOLVE_PG_SWITCH_MAX_EVENTS } from '../domain/pg-switch-control.js';
import type { CallBudget, PgSelectionBatchReader } from '../domain/ports.js';
import type { PgApprovalLimit } from './check-event-pg-assignment.js';

export interface ResolvePgSwitchInput {
  readonly eventIds: readonly string[];
  /** PgProvider에서 PG_PROVIDER_를 뗀 이름. 빈 글·UNSPECIFIED면 미리 지정한 대체 */
  readonly toPg: string;
}

export interface PgSwitchRoute {
  readonly eventId: string;
  readonly pg: PgName;
  /** 그 결제사의 초당 승인 상한. 설정에 없으면 0 */
  readonly approvalsPerSecond: number;
}

export interface ResolvePgSwitchAnswer {
  /** 요청 차례 */
  readonly routes: readonly PgSwitchRoute[];
  /** 설정에 있는 결제사의 승인 상한(이름 차례) */
  readonly approvalLimits: readonly PgApprovalLimit[];
}

export interface ResolvePgSwitchDeps {
  readonly selection: PgSelectionBatchReader;
  readonly defaults: PgPlatformDefaults;
  readonly approvalTps: ReadonlyMap<PgName, number>;
}

export class ResolvePgSwitch {
  constructor(private readonly deps: ResolvePgSwitchDeps) {}

  /**
   * @throws PaymentInputError 회차가 101개 이상·소문자 UUID 아님·겹침(event_ids), 결제사가 TOSS·PORTONE·UNSPECIFIED 밖(to_pg) · 저장소 오류
   */
  async execute(input: ResolvePgSwitchInput, budget?: CallBudget): Promise<ResolvePgSwitchAnswer> {
    const ids = input.eventIds;
    if (ids.length > RESOLVE_PG_SWITCH_MAX_EVENTS || ids.some((id) => !isLowerUuid(id)) || new Set(ids).size !== ids.length) throw new PaymentInputError('event_ids');
    const raw = input.toPg === '' || input.toPg === 'UNSPECIFIED' ? undefined : input.toPg;
    if (raw !== undefined && !PG_SWITCH_TARGETS.includes(raw as PgName)) throw new PaymentInputError('to_pg');
    const toPg = raw as PgName | undefined;
    const states = ids.length > 0 ? await this.deps.selection.readMany(ids, budget) : new Map();
    const routes = ids.map((eventId): PgSwitchRoute => {
      const pg = pgSwitchTargetOf(states.get(eventId) ?? {}, this.deps.defaults, toPg);
      return { eventId, pg, approvalsPerSecond: this.deps.approvalTps.get(pg) ?? 0 };
    });
    const approvalLimits = [...this.deps.approvalTps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pg, approvalsPerSecond]) => ({ pg, approvalsPerSecond }));
    return { routes, approvalLimits };
  }
}
