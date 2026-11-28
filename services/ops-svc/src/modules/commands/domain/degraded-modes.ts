// 명령 6(Degraded Mode 전환)의 새 갈래(F-02-6, 동결 로컬). 모드 이름·범위·감사 payload의 공통 함수만 둔다.
// 파라미터 검사는 command-params.ts가 하고(CommandInputRejected를 그 파일이 갖는다), 이 파일은 프레임워크·오류를 모른다.
// ENTRY_DEGRADED는 엣지 저장소 mode:entry(EdgeCommandExecutor), STATE_DEGRADED는 queue-svc notice,
// STATE_MIRROR_FIXED·SOLD_OUT_STATIC은 CloudFront 설정 포트가 맡는다(control-tower §3·§5, 2026-11-28 확정).

/** 명령 6 진입 Degraded. 엣지 저장소 mode:entry의 {"on", "expireAtMs"}를 쓴다 */
export const ENTRY_DEGRADED = 'ENTRY_DEGRADED';
/** 명령 6 상태 조회 Degraded. queue-svc notice의 stateDegraded를 쓴다 */
export const STATE_DEGRADED = 'STATE_DEGRADED';
/** 명령 6 대기 상태 파일 S3 사본 고정 */
export const STATE_MIRROR_FIXED = 'STATE_MIRROR_FIXED';
/** 명령 6 매진 정적 응답 */
export const SOLD_OUT_STATIC = 'SOLD_OUT_STATIC';

/** 전체 범위 이름(control-kinds의 CONTROL_SCOPE_PLATFORM과 같다. 순환 import를 피하려고 여기 둔다) */
export const DEGRADED_SCOPE_PLATFORM = 'PLATFORM';
/** ENTRY_DEGRADED의 만료 상한 24시간 [가정](명령 4 만료 상한과 같은 값) */
export const ENTRY_DEGRADED_MAX_TTL_MS = 24 * 60 * 60_000;
/** STATE_DEGRADED의 회차 수 상한 100 [가정](명령 6 결제 갈래와 같은 값) */
export const STATE_DEGRADED_MAX_EVENTS = 100;

/** 이 파일이 다루는 명령 6의 새 모드 */
export type DegradedMode =
  | typeof ENTRY_DEGRADED
  | typeof STATE_DEGRADED
  | typeof STATE_MIRROR_FIXED
  | typeof SOLD_OUT_STATIC;

export interface EntryDegradedParams {
  readonly mode: typeof ENTRY_DEGRADED;
  readonly expiresAt: string;
}

export interface StateDegradedParams {
  readonly mode: typeof STATE_DEGRADED;
  readonly scope: 'EVENT' | 'PLATFORM';
  readonly eventIds?: readonly string[];
}

export interface CdnDegradedParams {
  readonly mode: typeof STATE_MIRROR_FIXED | typeof SOLD_OUT_STATIC;
}

const DEGRADED_MODES: readonly string[] = [ENTRY_DEGRADED, STATE_DEGRADED, STATE_MIRROR_FIXED, SOLD_OUT_STATIC];

/** params.mode가 이 파일이 다루는 새 모드인가 */
export function degradedModeOf(params: Record<string, unknown>): DegradedMode | undefined {
  const mode = params.mode;
  return typeof mode === 'string' && DEGRADED_MODES.includes(mode) ? (mode as DegradedMode) : undefined;
}

/** 명령 6의 새 모드인가(결제 갈래·해제 갈래와 구분) */
export const isNewDegradedMode = (type: string, params: Record<string, unknown>): boolean => type === 'DEGRADED_MODE' && degradedModeOf(params) !== undefined;

/** 진입 Degraded 갈래인가 */
export const isEntryDegradedParams = (type: string, params: Record<string, unknown>): boolean =>
  type === 'DEGRADED_MODE' && params.mode === ENTRY_DEGRADED;

/** 상태 조회 Degraded 갈래인가 */
export const isStateDegradedParams = (type: string, params: unknown): boolean =>
  type === 'DEGRADED_MODE' &&
  typeof params === 'object' &&
  params !== null &&
  !Array.isArray(params) &&
  (params as Record<string, unknown>).mode === STATE_DEGRADED;

/** CDN 갈래(S3 사본 고정·매진 정적 응답)인가 */
export const isCdnModeParams = (type: string, params: Record<string, unknown>): boolean =>
  type === 'DEGRADED_MODE' && (params.mode === STATE_MIRROR_FIXED || params.mode === SOLD_OUT_STATIC);

/**
 * 감사 payload·DISPATCHED 사건 detail의 scope. ENTRY·CDN은 PLATFORM, STATE_DEGRADED의 EVENT는 첫 회차 ID다.
 * (검사는 접수 때 끝났으므로 여기서는 방어적으로 값이 없으면 PLATFORM을 준다.)
 */
export function degradedScopeOf(type: string, params: Record<string, unknown>): string {
  if (type !== 'DEGRADED_MODE' || !isStateDegradedParams(type, params) || params.scope === DEGRADED_SCOPE_PLATFORM) return DEGRADED_SCOPE_PLATFORM;
  const ids = params.eventIds;
  return Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : DEGRADED_SCOPE_PLATFORM;
}

/** 감사 기록에 더할 값. 새 모드가 아니면 undefined */
export function degradedAuditOf(type: string, params: Record<string, unknown>, transition: 'ON' | 'OFF'): Record<string, unknown> | undefined {
  if (!isNewDegradedMode(type, params)) return undefined;
  return { mode: params.mode, transition, scope: degradedScopeOf(type, params) };
}
