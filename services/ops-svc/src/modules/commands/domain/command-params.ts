// 명령 유형별 params 검사와 안전 한계(ADR-0340 결정 9·10, ADR-0339 결정 2, docs/features/control-tower.md §3 안전 허용 범위).
// 명령 1·2·3·4·5·12와 명령 6의 결제 갈래(PAYMENT_PG_FALLBACK, ADR-0349 결정 1·6)는 칸을 허용 목록으로 닫고(모르는 칸은 거절),
// 그 밖의 유형·명령 6의 다른 모드는 OPS-300이 oneOf로 닫을 때까지 객체만 본다.
// 꼴이 틀리면 'INVALID'(422 invalid-command), 안전 한계 밖이면 'OUT_OF_RANGE'(422 command-out-of-range, 걸린 한계 이름)다. 저장 전에 거른다.
import { BlockListInvalid, blockListsOf, type BlockParams } from './block-ranges.js';
import { PAYMENT_ENTRY_RELEASE, SAFETY_LIMITS, type CommandType } from './command.js';

/** 접수 검사 거절. 받는 층이 422로 바꾼다 */
export class CommandInputRejected extends Error {
  constructor(
    readonly kind: 'INVALID' | 'OUT_OF_RANGE',
    /** OUT_OF_RANGE면 걸린 한계 이름(SAFETY_LIMITS의 키), INVALID면 까닭 */
    readonly limit: string,
  ) {
    super(`${kind}:${limit}`);
    this.name = 'CommandInputRejected';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (why: string): never => {
  throw new CommandInputRejected('INVALID', why);
};
const outOfRange = (limit: keyof typeof SAFETY_LIMITS | 'blockExpiresAt' | 'pgFallbackMaxEvents'): never => {
  throw new CommandInputRejected('OUT_OF_RANGE', limit);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 허용한 칸 밖의 칸이 있으면 거절한다 */
const onlyKeys = (p: Record<string, unknown>, keys: readonly string[]): void => {
  for (const k of Object.keys(p)) if (!keys.includes(k)) invalid(`unknown-field:${k}`);
};
const uuidOf = (v: unknown, field: string): string => (typeof v === 'string' && UUID.test(v) ? v : invalid(`${field}`));
const intOf = (v: unknown, field: string): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : invalid(field));

/** 봇 판정 강도(명령 5, control-tower §3 '완화, 기본, 강화')와 대기 중 재평가 모드(ADR-0071) */
export const BOT_LEVELS = ['RELAXED', 'STANDARD', 'AGGRESSIVE'] as const;
export const BOT_REASSESS_MODES = ['OFF', 'SHADOW', 'ENFORCE'] as const;
/** 킬스위치 범위(명령 3, ADR-0062) */
export const KILL_SWITCH_SCOPES = ['EVENT', 'PLATFORM'] as const;
/** 명령 4의 칸 */
const BLOCK_KEYS = ['cidrs', 'asns', 'expiresAt'] as const;

/** 명령 1: {eventId, target, fromTarget?}. 목표는 절대 상·하한 안(8,000·1,000). fromTarget은 자동 조치가 본 지금 목표(낮추기 확인) */
function admissionTarget(p: Record<string, unknown>): Record<string, unknown> {
  onlyKeys(p, ['eventId', 'target', 'fromTarget']);
  uuidOf(p.eventId, 'eventId');
  const target = intOf(p.target, 'target');
  if (target > SAFETY_LIMITS.admissionTargetMax) outOfRange('admissionTargetMax');
  if (target < SAFETY_LIMITS.admissionTargetMin) outOfRange('admissionTargetMin');
  if (p.fromTarget !== undefined && intOf(p.fromTarget, 'fromTarget') < 1) invalid('fromTarget');
  return p;
}

/** 명령 2: {eventId}. 만료는 첫 ack + 10분이라 받지 않는다 */
function admissionPause(p: Record<string, unknown>): Record<string, unknown> {
  onlyKeys(p, ['eventId']);
  uuidOf(p.eventId, 'eventId');
  return p;
}

/** 명령 3: {scope, eventIds}. EVENT면 회차 1개 이상(겹침 없이), PLATFORM이면 회차를 받지 않는다 */
function killSwitch(p: Record<string, unknown>): Record<string, unknown> {
  onlyKeys(p, ['scope', 'eventIds']);
  if (!KILL_SWITCH_SCOPES.includes(p.scope as never)) invalid('scope');
  if (p.scope === 'EVENT') {
    if (!Array.isArray(p.eventIds) || p.eventIds.length === 0) invalid('eventIds');
    const ids = (p.eventIds as unknown[]).map((v) => uuidOf(v, 'eventIds').toLowerCase());
    if (new Set(ids).size !== ids.length) invalid('eventIds-duplicate');
  } else if (p.eventIds !== undefined && (!Array.isArray(p.eventIds) || p.eventIds.length > 0)) {
    invalid('eventIds');
  }
  return p;
}

/** 명령 5: {level, reassessMode?} */
function botLevel(p: Record<string, unknown>): Record<string, unknown> {
  onlyKeys(p, ['level', 'reassessMode']);
  if (!BOT_LEVELS.includes(p.level as never)) invalid('level');
  if (p.reassessMode !== undefined && !BOT_REASSESS_MODES.includes(p.reassessMode as never)) invalid('reassessMode');
  return p;
}

/** 명령 8이 로그 레벨을 올릴 수 있는 서비스(ADR-0365 결정 13, setting-commands의 목록과 같은 글) */
export const LOG_LEVEL_SERVICES = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc'] as const;
/** 명령 8의 수준은 올리는 둘뿐이다(내리는 것은 만료·되돌리기의 INFO) */
export const LOG_LEVEL_RAISED = ['DEBUG', 'TRACE'] as const;
/** 명령 9가 끌 수 있는 기능 플래그(서버 쪽에 실제 끄는 쪽이 있는 것만) */
export const FEATURE_FLAGS = ['reviews'] as const;

/** 설정형 명령의 모르는 칸은 그 칸 이름을 detail로 돌려준다(테스트·openapi: detail = 어긋난 칸) */
function onlySettingKeys(p: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of Object.keys(p)) if (!keys.includes(k)) invalid(k);
}

/** 명령 8의 매개변수 {service, level}. 서비스는 설정을 읽는 일곱, 수준은 DEBUG·TRACE만 받는다 */
export function logLevelParamsOf(p: Record<string, unknown>): { service: string; level: (typeof LOG_LEVEL_RAISED)[number] } {
  if (!isObject(p)) return invalid('params');
  onlySettingKeys(p, ['service', 'level']);
  if (typeof p.service !== 'string' || !(LOG_LEVEL_SERVICES as readonly string[]).includes(p.service)) invalid('service');
  if (typeof p.level !== 'string' || !(LOG_LEVEL_RAISED as readonly string[]).includes(p.level)) invalid('level');
  return { service: p.service as string, level: p.level as (typeof LOG_LEVEL_RAISED)[number] };
}

/** 명령 9의 매개변수 {flag}. 지금은 reviews만 받는다 */
export function featureOffParamsOf(p: Record<string, unknown>): { flag: (typeof FEATURE_FLAGS)[number] } {
  if (!isObject(p)) return invalid('params');
  onlySettingKeys(p, ['flag']);
  if (typeof p.flag !== 'string' || !(FEATURE_FLAGS as readonly string[]).includes(p.flag)) invalid('flag');
  return { flag: p.flag as (typeof FEATURE_FLAGS)[number] };
}

/** 명령 12·6 결제 갈래가 고르는 결제사(asyncapi PgAssignmentValue, ADR-0349 결정 1·6). 시뮬레이터는 고르지 못한다 */
export const ASSIGNABLE_PGS = ['TOSS', 'PORTONE'] as const;
export type AssignablePg = (typeof ASSIGNABLE_PGS)[number];
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lowerUuidOf = (v: unknown, field: string): string => (typeof v === 'string' && LOWER_UUID.test(v) ? v : invalid(field));
const pgOf = (v: unknown, field: string): AssignablePg => (ASSIGNABLE_PGS.includes(v as never) ? (v as AssignablePg) : invalid(field));

/** 명령 12 값 */
export interface PgAssignParams {
  readonly eventId: string;
  readonly primaryPg: AssignablePg;
  readonly fallbackPg?: AssignablePg;
}

/**
 * 명령 12: {eventId(소문자 UUID), primaryPg(TOSS|PORTONE), fallbackPg?(TOSS|PORTONE)}(ADR-0349 결정 1). 모르는 칸·기본 = 대체는 INVALID다.
 * 대체가 없으면 칸을 뺀다(null도 없음으로 읽는다)
 */
export function pgAssignParamsOf(p: Record<string, unknown>): PgAssignParams {
  onlyKeys(p, ['eventId', 'primaryPg', 'fallbackPg']);
  const eventId = lowerUuidOf(p.eventId, 'eventId');
  const primaryPg = pgOf(p.primaryPg, 'primaryPg');
  const fallbackPg = p.fallbackPg === undefined || p.fallbackPg === null ? undefined : pgOf(p.fallbackPg, 'fallbackPg');
  if (fallbackPg === primaryPg) invalid('fallbackPg-same-as-primary');
  return { eventId, primaryPg, ...(fallbackPg !== undefined ? { fallbackPg } : {}) };
}

/** 명령 6의 결제 갈래 '대체 결제사 전환' 모드 이름(asyncapi DegradedModeValue, ADR-0044) */
export const PAYMENT_PG_FALLBACK = 'PAYMENT_PG_FALLBACK';
/** 명령 6 결제 갈래 범위와 회차 수 상한 100 [가정](ADR-0349 결정 6) */
export const PG_FALLBACK_SCOPES = ['EVENT', 'PLATFORM'] as const;
export const PG_FALLBACK_MAX_EVENTS = 100;

/** 명령 6 결제 갈래 값 */
export interface PgFallbackParams {
  readonly mode: typeof PAYMENT_PG_FALLBACK;
  readonly scope: (typeof PG_FALLBACK_SCOPES)[number];
  readonly eventIds: readonly string[];
  readonly toPg?: AssignablePg;
}

/**
 * 명령 6 결제 갈래: {mode: PAYMENT_PG_FALLBACK, scope: EVENT|PLATFORM, eventIds, toPg?}(ADR-0349 결정 6).
 * EVENT면 소문자 UUID 1~100개(겹침 없음, 101개 이상은 OUT_OF_RANGE pgFallbackMaxEvents), PLATFORM이면 회차를 받지 않는다(빈 목록은 받는다)
 */
export function pgFallbackParamsOf(p: Record<string, unknown>): PgFallbackParams {
  onlyKeys(p, ['mode', 'scope', 'eventIds', 'toPg']);
  if (p.mode !== PAYMENT_PG_FALLBACK) invalid('mode');
  if (!PG_FALLBACK_SCOPES.includes(p.scope as never)) invalid('scope');
  const scope = p.scope as PgFallbackParams['scope'];
  let eventIds: string[] = [];
  if (scope === 'EVENT') {
    if (!Array.isArray(p.eventIds) || p.eventIds.length === 0) invalid('eventIds');
    eventIds = (p.eventIds as unknown[]).map((v) => lowerUuidOf(v, 'eventIds'));
    if (new Set(eventIds).size !== eventIds.length) invalid('eventIds-duplicate');
    if (eventIds.length > PG_FALLBACK_MAX_EVENTS) outOfRange('pgFallbackMaxEvents');
  } else if (p.eventIds !== undefined && (!Array.isArray(p.eventIds) || p.eventIds.length > 0)) {
    invalid('eventIds');
  }
  const toPg = p.toPg === undefined || p.toPg === null ? undefined : pgOf(p.toPg, 'toPg');
  return { mode: PAYMENT_PG_FALLBACK, scope, eventIds, ...(toPg !== undefined ? { toPg } : {}) };
}

/** 명령 6이 결제 갈래(mode PAYMENT_PG_FALLBACK)인가. 다른 모드 갈래는 OPS-300·310이 닫을 때까지 열어 둔다 */
export const isPgFallbackParams = (type: CommandType, params: unknown): boolean => type === 'DEGRADED_MODE' && isObject(params) && params.mode === PAYMENT_PG_FALLBACK;

/** 명령 6 해제 갈래가 고르는 결제사(ADR-0366 결정 8). SIMULATOR는 local·ci만 받는다 */
export const ENTRY_RELEASE_PGS = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;
export type EntryReleasePg = (typeof ENTRY_RELEASE_PGS)[number];

/** 명령 6 해제 갈래 값 */
export interface EntryReleaseParams {
  readonly mode: typeof PAYMENT_ENTRY_RELEASE;
  readonly pg: EntryReleasePg;
}

/**
 * 명령 6 해제 갈래: {mode: PAYMENT_ENTRY_RELEASE, pg: TOSS|PORTONE|SIMULATOR}(ADR-0366 결정 8). 모르는 칸·다른 결제사, local·ci 밖의 SIMULATOR는 INVALID다
 * @param o.simulatorPg SIMULATOR를 받는가(local·ci만 참)
 */
export function entryReleaseParamsOf(p: Record<string, unknown>, o: { readonly simulatorPg?: boolean } = {}): EntryReleaseParams {
  onlyKeys(p, ['mode', 'pg']);
  if (p.mode !== PAYMENT_ENTRY_RELEASE) invalid('mode');
  if (!ENTRY_RELEASE_PGS.includes(p.pg as never) || (p.pg === 'SIMULATOR' && o.simulatorPg !== true)) invalid('pg');
  return { mode: PAYMENT_ENTRY_RELEASE, pg: p.pg as EntryReleasePg };
}

/**
 * 명령 4: {cidrs?, asns?, expiresAt}(ADR-0339 결정 1·2). 꼴이 틀린 대역·호스트 비트·/0·빈 목록 둘·같은 항목 두 번은 INVALID,
 * 항목 합계 100개 초과·만료 없음·지금 이하·지금 + 24시간 초과는 OUT_OF_RANGE다
 */
export function blockParamsOf(p: Record<string, unknown>, nowMs: number): BlockParams {
  onlyKeys(p, BLOCK_KEYS);
  let lists: Pick<BlockParams, 'cidrs' | 'asns'>;
  try {
    lists = blockListsOf(p);
  } catch (e) {
    return invalid(e instanceof BlockListInvalid ? e.why : 'lists');
  }
  const { cidrs, asns } = lists;
  if (cidrs.length + asns.length > SAFETY_LIMITS.blockMaxEntries) outOfRange('blockMaxEntries');
  if (p.expiresAt === undefined) outOfRange('blockExpiresAt');
  if (typeof p.expiresAt !== 'string') invalid('expiresAt');
  const expiresAtMs = Date.parse(p.expiresAt as string);
  if (!Number.isFinite(expiresAtMs)) invalid('expiresAt');
  if (expiresAtMs <= nowMs || expiresAtMs > nowMs + SAFETY_LIMITS.blockMaxTtlMs) outOfRange('blockMaxTtlMs');
  return { cidrs, asns, expiresAtMs };
}

/**
 * 유형별 params를 검사한다. 명령 1·2·3·4·5·12와 명령 6 결제 갈래는 허용 목록으로 닫는다(명령 12·6 결제 갈래는 고른 값만 담은 새 객체를 돌려준다).
 * @throws CommandInputRejected 꼴(INVALID)·안전 한계(OUT_OF_RANGE)
 */
export function checkCommandParams(type: CommandType, params: unknown, nowMs: number, o: { readonly simulatorPg?: boolean } = {}): Record<string, unknown> {
  if (!isObject(params)) return invalid('params');
  switch (type) {
    case 'ADMISSION_TARGET':
      return admissionTarget(params);
    case 'ADMISSION_PAUSE':
      return admissionPause(params);
    case 'KILL_SWITCH':
      return killSwitch(params);
    case 'BLOCK_ASN_IP':
      blockParamsOf(params, nowMs);
      return params;
    case 'BOT_LEVEL':
      return botLevel(params);
    case 'LOG_LEVEL':
      return { ...logLevelParamsOf(params) };
    case 'FEATURE_OFF':
      return { ...featureOffParamsOf(params) };
    case 'PG_ASSIGN':
      return { ...pgAssignParamsOf(params) };
    case 'DEGRADED_MODE': {
      // 결제 갈래(ADR-0349 결정 6)와 해제 갈래(ADR-0366 결정 8)를 닫는다. 다른 모드는 F-02-6이 닫을 때까지 객체만 본다
      if (params.mode === PAYMENT_ENTRY_RELEASE) return { ...entryReleaseParamsOf(params, o) };
      if (params.mode !== PAYMENT_PG_FALLBACK) return params;
      const f = pgFallbackParamsOf(params);
      return { mode: f.mode, scope: f.scope, ...(f.scope === 'EVENT' ? { eventIds: [...f.eventIds] } : {}), ...(f.toPg !== undefined ? { toPg: f.toPg } : {}) };
    }
    default:
      return params;
  }
}

/** 사유 글(ADR-0340 결정 10): 앞뒤 공백을 지우고 NFC로 한 번 정규화한 뒤 1~2,000자. 제어 문자·양방향 제어 문자는 거절 */
export const REASON_MAX = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[‪-‮⁦-⁩]/;
export function normalizeReason(raw: unknown): string {
  if (typeof raw !== 'string') return invalid('reason');
  const reason = raw.trim().normalize('NFC');
  if (reason.length === 0 || reason.length > REASON_MAX || CONTROL.test(reason) || BIDI.test(reason)) invalid('reason');
  return reason;
}
