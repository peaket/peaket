// 명령 6 결제 갈래의 받는 쪽별 바라는 상태(F-02-2 OPS-310, ADR-0366 결정 1·2·4·5·7·8). 이 파일은 프레임워크를 모른다.
// - 대체 결제사 전환(PAYMENT_PG_FALLBACK)은 범위(회차마다 또는 PLATFORM)마다 CONTROL_KIND_PG_SWITCH를 payment-svc 준비된 모든 파드와 admission-ctrl 리더에 보낸다.
//   payment-svc {"switched", "toPg"}, admission-ctrl {"switched", "pgKey", "pgTps"}. 회차 범위의 pgKey·pgTps는 ResolvePgSwitch가 준 갈 결제사와 내림(승인 상한)(1 미만이면 1),
//   전체 범위는 toPg가 있으면 그 결제사의 이름·상한, 없으면 PG_FALLBACK·TOSS와 PORTONE 상한의 최솟값이다(낮은 쪽으로 안전하게)
// - 끄기(되돌리기)는 {"switched": false, "toPg": null}·{"switched": false, "pgKey": null, "pgTps": null}이고, 이어 TOSS·PORTONE 해제를 보낸다
// - 해제(PAYMENT_ENTRY_RELEASE)는 PLATFORM 범위 CONTROL_KIND_ENTRY_PAUSE_RELEASE {"pg", "actor"}를 payment-svc 준비된 모든 파드에 보낸다
import type { ControlDelivery } from './control-kinds.js';
import type { PgName } from './ports.js';

/** ResolvePgSwitch가 준 회차 하나의 갈 곳 */
export interface PgSwitchRoute {
  readonly eventId: string;
  readonly pg: PgName;
  /** 그 결제사의 초당 승인 상한(설정에 없으면 0) */
  readonly approvalsPerSecond: number;
}

/** ResolvePgSwitch의 답(회차마다 갈 곳과 설정에 있는 결제사의 승인 상한) */
export interface PgSwitchRoutes {
  readonly routes: readonly PgSwitchRoute[];
  readonly approvalLimits: Readonly<Partial<Record<PgName, number>>>;
}

/** 전체 범위 대체 미지정 전환의 결제사 묶음 이름(ADR-0366 결정 5, admission-ctrl pg-ratio.ts와 같은 값) */
export const PG_FALLBACK_GROUP = 'PG_FALLBACK';
/** 전체 범위 대체 미지정 전환의 최솟값을 고르는 결제사(ADR-0366 결정 5) */
export const PG_FALLBACK_LIMIT_PGS: readonly PgName[] = ['TOSS', 'PORTONE'];
/** 되돌리기가 함께 여는 결제사(Degraded Mode 모두 해제, ADR-0366 결정 7) */
export const REVERT_RELEASE_PGS: readonly PgName[] = ['TOSS', 'PORTONE'];
/** 제어 종류 이름 */
export const PG_SWITCH_KIND = 'CONTROL_KIND_PG_SWITCH' as const;
export const ENTRY_PAUSE_RELEASE_KIND = 'CONTROL_KIND_ENTRY_PAUSE_RELEASE' as const;
const PLATFORM = 'PLATFORM';

/** 승인 상한 → admission-ctrl pgTps(내림, 1 미만이면 1). 0 이하·수가 아니면 undefined(상한을 모른다) */
export function pgTpsOf(approvalsPerSecond: number | undefined): number | undefined {
  if (approvalsPerSecond === undefined || !Number.isFinite(approvalsPerSecond) || approvalsPerSecond <= 0) return undefined;
  return Math.max(1, Math.floor(approvalsPerSecond));
}

/** 그 범위의 admission-ctrl 결제사 묶음. 상한을 모르면 undefined(부르는 쪽이 503 pg-check-unavailable로 막는다) */
export function admissionPgOf(scope: string, toPg: PgName | undefined, routes: PgSwitchRoutes): { pgKey: string; pgTps: number } | undefined {
  if (scope !== PLATFORM) {
    const r = routes.routes.find((x) => x.eventId === scope);
    const tps = pgTpsOf(r?.approvalsPerSecond);
    return r && tps !== undefined ? { pgKey: r.pg, pgTps: tps } : undefined;
  }
  if (toPg !== undefined) {
    const tps = pgTpsOf(routes.approvalLimits[toPg]);
    return tps !== undefined ? { pgKey: toPg, pgTps: tps } : undefined;
  }
  // 대체 미지정 전체 범위는 TOSS·PORTONE 상한이 모두 있어야 최솟값을 정한다. 한쪽이라도 모르면 낮은 쪽을 알 수 없어 보내지 않는다(503, ADR-0366 결정 5, RV-02)
  const limits = PG_FALLBACK_LIMIT_PGS.map((pg) => routes.approvalLimits[pg]);
  const known = limits.filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0);
  const tps = known.length === limits.length ? pgTpsOf(Math.min(...known)) : undefined;
  return tps !== undefined ? { pgKey: PG_FALLBACK_GROUP, pgTps: tps } : undefined;
}

/** 갈 곳을 모르는 범위(상한 0·없음). 비었으면 보낼 수 있다 */
export function missingPgRoutes(scopes: readonly string[], toPg: PgName | undefined, routes: PgSwitchRoutes): string[] {
  return scopes.filter((s) => admissionPgOf(s, toPg, routes) === undefined);
}

const json = (v: Record<string, unknown>): string => JSON.stringify(v);

/**
 * 대체 결제사 전환을 켜는 바라는 상태(범위마다 payment-svc·admission-ctrl 둘).
 * @returns 갈 곳을 모르는 범위가 있으면 undefined
 */
export function pgSwitchDesiredStates(scopes: readonly string[], toPg: PgName | undefined, routes: PgSwitchRoutes): ControlDelivery[] | undefined {
  const out: ControlDelivery[] = [];
  for (const scope of scopes) {
    const pg = admissionPgOf(scope, toPg, routes);
    if (!pg) return undefined;
    out.push({ service: 'payment-svc', scope, kind: PG_SWITCH_KIND, desiredStateJson: json({ switched: true, toPg: toPg ?? null }) });
    out.push({ service: 'admission-ctrl', scope, kind: PG_SWITCH_KIND, desiredStateJson: json({ switched: true, pgKey: pg.pgKey, pgTps: pg.pgTps }) });
  }
  return out;
}

/** 대체 결제사 전환을 끄는 바라는 상태(범위마다 payment-svc·admission-ctrl 둘) */
export function pgSwitchOffStates(scopes: readonly string[]): ControlDelivery[] {
  return scopes.flatMap((scope): ControlDelivery[] => [
    { service: 'payment-svc', scope, kind: PG_SWITCH_KIND, desiredStateJson: json({ switched: false, toPg: null }) },
    { service: 'admission-ctrl', scope, kind: PG_SWITCH_KIND, desiredStateJson: json({ switched: false, pgKey: null, pgTps: null }) },
  ]);
}

/** 새 결제 진입 정지 해제(결제사마다 payment-svc 하나, PLATFORM). actor는 요청자(되돌리기면 되돌린 사람)의 관리 계정 ID */
export function entryReleaseStates(pgs: readonly PgName[], actor: string): ControlDelivery[] {
  return pgs.map((pg) => ({ service: 'payment-svc', scope: PLATFORM, kind: ENTRY_PAUSE_RELEASE_KIND, desiredStateJson: json({ pg, actor }) }));
}
