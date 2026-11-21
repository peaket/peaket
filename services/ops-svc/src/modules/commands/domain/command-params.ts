// 명령 유형별 params 검사와 안전 한계(ADR-0340 결정 9·10, ADR-0339 결정 2, docs/features/control-tower.md §3 안전 허용 범위).
// 명령 1·2·3·4·5는 칸을 허용 목록으로 닫고(모르는 칸은 거절), 그 밖의 유형은 OPS-300이 oneOf로 닫을 때까지 객체만 본다.
// 꼴이 틀리면 'INVALID'(422 invalid-command), 안전 한계 밖이면 'OUT_OF_RANGE'(422 command-out-of-range, 걸린 한계 이름)다. 저장 전에 거른다.
import { BlockListInvalid, blockListsOf, type BlockParams } from './block-ranges.js';
import { SAFETY_LIMITS, type CommandType } from './command.js';

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
const outOfRange = (limit: keyof typeof SAFETY_LIMITS | 'blockExpiresAt'): never => {
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
 * 유형별 params를 검사한다. 명령 1·2·3·4·5는 허용 목록으로 닫는다.
 * @throws CommandInputRejected 꼴(INVALID)·안전 한계(OUT_OF_RANGE)
 */
export function checkCommandParams(type: CommandType, params: unknown, nowMs: number): Record<string, unknown> {
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
