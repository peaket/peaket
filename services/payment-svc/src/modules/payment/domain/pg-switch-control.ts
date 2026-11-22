// 명령 6 결제 갈래를 제어 gRPC로 받는 값과 규칙(F-02-2 OPS-310, ADR-0366 결정 2·5·8·9, docs/features/payment.md §2.2 '선택기의 첫 구현').
// - CONTROL_KIND_PG_SWITCH의 바라는 상태 {"switched": 참거짓, "toPg": "TOSS"|"PORTONE"|null}(toPg는 빠져도 null로 읽는다)
// - CONTROL_KIND_ENTRY_PAUSE_RELEASE의 바라는 상태 {"pg": "TOSS"|"PORTONE"|"SIMULATOR", "actor": 요청자 관리 계정 ID}(SIMULATOR는 local·ci만)
// - ResolvePgSwitch의 '전환이 켜졌을 때 그 회차의 새 결제 시도가 갈 결제사'(선택기와 같은 규칙, basePgOf를 쓴다)
// 모르는 칸·틀린 꼴은 PgSwitchControlRejected(받는 층이 INVALID_ARGUMENT, 쓰기 0). 이 파일은 프레임워크·저장소를 모른다.
import { isLowerUuid } from './confirm-command.js';
import type { PgName } from './payment-gateway.js';
import { basePgOf, type PgPlatformDefaults, type PgSelectionState, type PgSwitchRow } from './pg-selection.js';

/** 전체 범위 이름(ApplyControlRequest.scope, pg_switch.scope) */
export const PG_SWITCH_PLATFORM_SCOPE = 'PLATFORM';
/** 전환이 옮겨 갈 수 있는 결제사(ADR-0366 결정 2). 시뮬레이터는 운영 결제사가 아니다 */
export const PG_SWITCH_TARGETS: readonly PgName[] = ['TOSS', 'PORTONE'];
/** 해제할 수 있는 결제사. SIMULATOR는 local·ci만(ADR-0366 결정 8) */
export const ENTRY_RELEASE_PGS: readonly PgName[] = ['TOSS', 'PORTONE', 'SIMULATOR'];
/** ResolvePgSwitch 회차 수 상한(명령 6 회차 범위 상한과 같다, ADR-0349 결정 6) */
export const RESOLVE_PG_SWITCH_MAX_EVENTS = 100;

/** 받은 제어 값이 꼴에 맞지 않음(why는 오류 글에 싣는 짧은 까닭) */
export class PgSwitchControlRejected extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;
  constructor(readonly why: string) {
    super(`${why}가 올바르지 않다`);
    this.name = 'PgSwitchControlRejected';
  }
}

const reject = (why: string): never => {
  throw new PgSwitchControlRejected(why);
};

function objectOf(json: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return reject('desired_state_json');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) reject('desired_state_json');
  return v as Record<string, unknown>;
}

/** 범위 글: PLATFORM 또는 소문자 회차 ID(ops-svc 원장의 범위 글과 같다) */
export function pgSwitchScopeOf(scope: string): string {
  return scope === PG_SWITCH_PLATFORM_SCOPE || isLowerUuid(scope) ? scope : reject('scope');
}

/** 대체 결제사 전환의 바라는 상태 */
export interface PgSwitchDesired {
  readonly switched: boolean;
  /** 없으면 미리 지정한 대체 결제사 */
  readonly toPg?: PgName;
}

/**
 * {"switched": 참거짓, "toPg": "TOSS"|"PORTONE"|null}을 읽는다. 모르는 칸, switched 없음·참거짓 아님, 틀린 결제사는 거절한다.
 * @throws PgSwitchControlRejected
 */
export function pgSwitchDesiredOf(json: string): PgSwitchDesired {
  const v = objectOf(json);
  for (const k of Object.keys(v)) if (k !== 'switched' && k !== 'toPg') reject('desired_state_json');
  if (typeof v.switched !== 'boolean') reject('switched');
  if (v.toPg === undefined || v.toPg === null) return { switched: v.switched as boolean };
  if (!PG_SWITCH_TARGETS.includes(v.toPg as PgName)) reject('toPg');
  return { switched: v.switched as boolean, toPg: v.toPg as PgName };
}

/** pg_switch에 쓸 행(어느 기준 결제사든 전환한다: from_pg = null, ADR-0366 결정 2) */
export function pgSwitchRowOf(scope: string, desired: PgSwitchDesired, version: number, nowMs: number): PgSwitchRow {
  return { scope, active: desired.switched, ...(desired.toPg !== undefined ? { toPg: desired.toPg } : {}), version, changedAtMs: nowMs };
}

/** 새 결제 진입 정지 해제의 바라는 상태 */
export interface EntryReleaseDesired {
  readonly pg: PgName;
  /** 명령 요청자(되돌리기면 되돌린 사람)의 관리 계정 ID. SYSTEM이 아니어야 모든 파드가 서킷을 닫는다(payment.md §2 PRF-202 ①) */
  readonly actor: string;
}

/**
 * {"pg": 결제사, "actor": 관리 계정 ID}를 읽는다. 범위는 PLATFORM만. SIMULATOR는 allowSimulator일 때만(local·ci).
 * actor 글의 길이·제어 문자 검사는 쓰임새(parseReleaseEntryPause)가 한다
 * @throws PgSwitchControlRejected
 */
export function entryReleaseDesiredOf(scope: string, json: string, allowSimulator: boolean): EntryReleaseDesired {
  if (scope !== PG_SWITCH_PLATFORM_SCOPE) reject('scope');
  const v = objectOf(json);
  const keys = Object.keys(v).sort();
  if (keys.length !== 2 || keys[0] !== 'actor' || keys[1] !== 'pg') reject('desired_state_json');
  if (!ENTRY_RELEASE_PGS.includes(v.pg as PgName) || (v.pg === 'SIMULATOR' && !allowSimulator)) reject('pg');
  if (typeof v.actor !== 'string' || v.actor.length === 0) reject('actor');
  return { pg: v.pg as PgName, actor: v.actor as string };
}

/**
 * 전환이 켜졌을 때 그 회차의 새 결제 시도가 갈 결제사(ADR-0366 결정 5): toPg가 있으면 그 결제사, 없으면 회차 지정의 대체, 지정이 없으면 플랫폼 대체.
 * 대체가 없으면 기준 결제사다(F-02-2 계획 14절 3). 선택기(basePgOf)에 그 회차의 켜진 전환 행을 넣어 같은 규칙으로 정한다(수단·채널 상태는 보지 않는다)
 */
export function pgSwitchTargetOf(state: Pick<PgSelectionState, 'assignment'>, defaults: PgPlatformDefaults, toPg?: PgName): PgName {
  const eventSwitch: PgSwitchRow = { scope: 'resolve', active: true, ...(toPg !== undefined ? { toPg } : {}), version: 0, changedAtMs: 0 };
  return basePgOf({ ...(state.assignment ? { assignment: state.assignment } : {}), eventSwitch, defaults });
}

/** pg_switch 행 읽기와 쓰기(받는 쪽 적용과 시작 때 한 번 읽기) */
export interface PgSwitchControlStore {
  /** 판이 지금 행보다 클 때만 쓴다(UPSERT 한 문장). 썼으면 참 */
  applySwitch(row: PgSwitchRow): Promise<boolean>;
  /** 그 범위 행. 없으면 undefined */
  readSwitch(scope: string): Promise<PgSwitchRow | undefined>;
  /** 모든 행(새 파드의 시작 읽기, ADR-0366 결정 3) */
  readAll(): Promise<readonly PgSwitchRow[]>;
}
