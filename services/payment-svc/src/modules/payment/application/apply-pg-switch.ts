// 명령 6 대체 결제사 전환 받기(제어 gRPC CONTROL_KIND_PG_SWITCH, F-02-2 OPS-310, ADR-0366 결정 2, ADR-0143 결정 1).
// pg_switch(범위 = 요청 범위)에 판이 클 때만 active·from_pg = null·to_pg·version·changed_at을 쓰고, 이 파드의 결제사 선택 캐시를 그 범위(전체면 모두)만큼 바로 비운다.
// 답하는 판은 쓴 뒤 다시 읽은 그 범위 행의 판이다(같거나 작은 판은 쓰지 않고 지금 판을 답한다). 범위·바라는 상태 검사는 받는 층이 먼저 한다.
import type { PgSwitchRow } from '../domain/pg-selection.js';
import { PG_SWITCH_PLATFORM_SCOPE, pgSwitchRowOf, type PgSwitchControlStore, type PgSwitchDesired } from '../domain/pg-switch-control.js';

export interface ApplyPgSwitchDeps {
  readonly store: PgSwitchControlStore;
  /** 이 파드의 결제사 선택 캐시(CachedPgSelectionReader). eventId가 없으면 모두 비운다 */
  readonly selection: { invalidate(eventId?: string): void };
  readonly clock: { now(): number };
}

export interface ApplyPgSwitchInput {
  /** PLATFORM 또는 소문자 회차 ID */
  readonly scope: string;
  readonly desired: PgSwitchDesired;
  /** 1 이상 안전 정수 */
  readonly version: number;
}

export interface ApplyPgSwitchResult {
  /** 다시 읽은 그 범위 행의 판(행이 없으면 0) */
  readonly appliedVersion: number;
  /** 이번에 썼는가 */
  readonly written: boolean;
  /** 다시 읽은 행 */
  readonly row?: PgSwitchRow;
}

export class ApplyPgSwitch {
  constructor(private readonly deps: ApplyPgSwitchDeps) {}

  /** @throws 저장소 오류(받는 층이 UNAVAILABLE, ops-svc가 같은 판으로 다시 보낸다) */
  async run(input: ApplyPgSwitchInput): Promise<ApplyPgSwitchResult> {
    const written = await this.deps.store.applySwitch(pgSwitchRowOf(input.scope, input.desired, input.version, this.deps.clock.now()));
    // 다음 결제 시도가 1초 캐시를 기다리지 않게 바로 비운다(쓰지 않았어도 비운다: 다른 파드가 먼저 쓴 같은 판을 이 파드도 곧바로 본다)
    this.deps.selection.invalidate(input.scope === PG_SWITCH_PLATFORM_SCOPE ? undefined : input.scope);
    const row = await this.deps.store.readSwitch(input.scope);
    return { appliedVersion: row?.version ?? 0, written, ...(row ? { row } : {}) };
  }
}
