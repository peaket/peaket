// SCR-030 명령 1·3·6(결제 갈래) 작성 값 → 접수 본문, 화면 막힘, 멱등 키 묶음(F-03-4, OPS-390).
// 본문 칸은 openapi Command.params 설명(ADMISSION_TARGET {eventId, target, fromTarget}, KILL_SWITCH {scope, eventIds},
// DEGRADED_MODE 결제 갈래 {mode: PAYMENT_PG_FALLBACK, scope, eventIds, toPg}, 해제 갈래 {mode: PAYMENT_ENTRY_RELEASE, pg})만 싣는다. 길이·범위·정규화 검사의 정본은 서버다(ADR-0340 결정 10).
// 막힘 글은 d5 §7.3 CMP-036 disabled 꼴, 휴대폰 막힘은 control-tower §12 '휴대폰·태블릿'. 화면 막힘은 편의이고 권한은 서버가 막는다(ASVS 8.3.1).

export type ConsoleRole = 'viewer' | 'operator' | 'commander' | (string & {});
export type ConsoleLayoutKind = 'phone' | 'tablet' | 'desktop';
export type CommandKind =
  | 'ADMISSION_TARGET'
  | 'KILL_SWITCH'
  | 'PG_FALLBACK'
  | 'PG_ENTRY_RELEASE'
  | 'ADMISSION_PAUSE'
  | 'BLOCK_ASN_IP'
  | 'BOT_LEVEL'
  | 'LOG_LEVEL'
  | 'FEATURE_OFF'
  | 'AUTOMATION_STOP'
  | 'PG_ASSIGN';
export type CommandScope = 'EVENT' | 'PLATFORM';
export type PgName = 'TOSS' | 'PORTONE';
/** 해제 갈래의 결제사. SIMULATOR(결제사 흉내 서버)는 local·ci만(openapi Command.params 설명) */
export type ReleasePg = PgName | 'SIMULATOR';
export type BotLevel = 'RELAXED' | 'STANDARD' | 'AGGRESSIVE';
export type ReassessMode = 'OFF' | 'SHADOW' | 'ENFORCE';

export type CommandDraft =
  | { kind: 'ADMISSION_TARGET'; eventId: string; target: number; fromTarget?: number; reason: string }
  | { kind: 'KILL_SWITCH'; scope: CommandScope; eventId?: string; reason: string }
  | { kind: 'PG_FALLBACK'; scope: CommandScope; eventId?: string; toPg?: PgName; reason: string }
  /** 명령 6 해제: 결제사 장애로 payment-svc가 스스로 건 새 결제 진입 정지를 연다(commander 1인·재인증, ADR-0366 결정 8) */
  | { kind: 'PG_ENTRY_RELEASE'; pg?: ReleasePg; reason: string }
  /** 명령 2: 입장 일시정지(operator 1인, 10분 만료) */
  | { kind: 'ADMISSION_PAUSE'; eventId: string; reason: string }
  /** 명령 4: ASN·IP 대역 차단(operator 1인, 2인 조건은 서버 판정, 만료 필수) */
  | { kind: 'BLOCK_ASN_IP'; cidrsText: string; asnsText: string; expiresAt: string; reason: string }
  /** 명령 5: 봇 판정 강도(commander 요청 + operator 이상 승인, 둘 다 재인증) */
  | { kind: 'BOT_LEVEL'; level: BotLevel; reassessMode?: ReassessMode; reason: string }
  /** 명령 8: 로그 레벨(계약 params가 아직 열려 있어 service·level 최소 칸만) */
  | { kind: 'LOG_LEVEL'; service: string; level: 'DEBUG' | 'TRACE' | 'INFO'; reason: string }
  /** 명령 9: 비핵심 기능 끄기(계약 params가 아직 열려 있어 flag 최소 칸만) */
  | { kind: 'FEATURE_OFF'; flag: string; reason: string }
  /** 명령 11: 자동화 정지(commander 1인, 휴대폰도 허용, params 없음) */
  | { kind: 'AUTOMATION_STOP'; reason: string }
  /** 명령 12: 결제사 지정(온세일 윈도우 밖, 1인 승인) */
  | { kind: 'PG_ASSIGN'; eventId: string; primaryPg: PgName; fallbackPg?: PgName; reason: string };

/** 명령 1·3·6의 작성 값(SCR-030 기존 폼). 새 명령은 MoreCommands가 맡는다 */
export type SimpleCommandDraft = Extract<CommandDraft, { kind: 'ADMISSION_TARGET' | 'KILL_SWITCH' | 'PG_FALLBACK' | 'PG_ENTRY_RELEASE' }>;

export type CommandType =
  | 'ADMISSION_TARGET'
  | 'KILL_SWITCH'
  | 'DEGRADED_MODE'
  | 'ADMISSION_PAUSE'
  | 'BLOCK_ASN_IP'
  | 'BOT_LEVEL'
  | 'LOG_LEVEL'
  | 'FEATURE_OFF'
  | 'AUTOMATION_STOP'
  | 'PG_ASSIGN';

/** openapi Command(접수·dry-run 본문) */
export interface CommandBody {
  type: CommandType;
  reason: string;
  params?: Record<string, unknown>;
}

export interface Availability {
  canRequest: boolean;
  reason?: string;
}

/** 화면 이름(카탈로그 카드·막힘 글) */
export const COMMAND_NAMES: Record<CommandKind, string> = {
  ADMISSION_TARGET: '동시 입장 목표',
  KILL_SWITCH: '판매 일시정지',
  PG_FALLBACK: '대체 결제사 전환',
  PG_ENTRY_RELEASE: '새 결제 진입 정지 열기',
  ADMISSION_PAUSE: '입장 일시정지',
  BLOCK_ASN_IP: 'ASN·IP 대역 차단',
  BOT_LEVEL: '봇 판정 강도',
  LOG_LEVEL: '로그 레벨',
  FEATURE_OFF: '비핵심 기능 끄기',
  AUTOMATION_STOP: '자동화 정지',
  PG_ASSIGN: '결제사 지정',
};

export const PHONE_BLOCKED = '명령 요청과 실행은 태블릿이나 데스크톱에서 합니다';

const isUuidLike = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 회차 범위 칸: 이 회차면 eventIds: [회차], 전체면 칸 없이 scope만. 회차가 없으면 null */
function scopeParams(scope: CommandScope, eventId: string | undefined): Record<string, unknown> | null {
  if (scope === 'PLATFORM') return { scope: 'PLATFORM' };
  if (!isUuidLike(eventId)) return null;
  return { scope: 'EVENT', eventIds: [eventId] };
}

const splitList = (v: string): string[] => v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** 작성 값 → 접수 본문. 칸이 모자라면 null(화면은 [보내기]를 막는다). 사유는 앞뒤 공백만 지운다 */
export function commandBodyOf(draft: CommandDraft): CommandBody | null {
  const reason = draft.reason.trim();
  if (reason === '') return null;
  switch (draft.kind) {
    case 'ADMISSION_TARGET': {
      if (!isUuidLike(draft.eventId) || !Number.isFinite(draft.target)) return null;
      const params: Record<string, unknown> = { eventId: draft.eventId, target: draft.target };
      if (draft.fromTarget !== undefined && Number.isFinite(draft.fromTarget)) params.fromTarget = draft.fromTarget;
      return { type: 'ADMISSION_TARGET', reason, params };
    }
    case 'KILL_SWITCH': {
      const params = scopeParams(draft.scope, draft.eventId);
      return params ? { type: 'KILL_SWITCH', reason, params } : null;
    }
    case 'PG_FALLBACK': {
      const scope = scopeParams(draft.scope, draft.eventId);
      if (!scope) return null;
      return { type: 'DEGRADED_MODE', reason, params: { mode: 'PAYMENT_PG_FALLBACK', ...scope, ...(draft.toPg ? { toPg: draft.toPg } : {}) } };
    }
    case 'PG_ENTRY_RELEASE':
      return draft.pg ? { type: 'DEGRADED_MODE', reason, params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: draft.pg } } : null;
    case 'ADMISSION_PAUSE':
      return isUuidLike(draft.eventId) ? { type: 'ADMISSION_PAUSE', reason, params: { eventId: draft.eventId } } : null;
    case 'BLOCK_ASN_IP': {
      const cidrs = splitList(draft.cidrsText);
      const asnTexts = splitList(draft.asnsText);
      if (cidrs.length === 0 || asnTexts.length === 0) return null;
      const asns = asnTexts.map(Number);
      if (asns.some((n) => !Number.isInteger(n) || n < 1)) return null;
      const expires = Date.parse(draft.expiresAt);
      if (!Number.isFinite(expires)) return null;
      return { type: 'BLOCK_ASN_IP', reason, params: { cidrs, asns, expiresAt: new Date(expires).toISOString() } };
    }
    case 'BOT_LEVEL': {
      if (draft.level !== 'RELAXED' && draft.level !== 'STANDARD' && draft.level !== 'AGGRESSIVE') return null;
      if (draft.reassessMode !== undefined && draft.reassessMode !== 'OFF' && draft.reassessMode !== 'SHADOW' && draft.reassessMode !== 'ENFORCE') return null;
      return { type: 'BOT_LEVEL', reason, params: { level: draft.level, ...(draft.reassessMode ? { reassessMode: draft.reassessMode } : {}) } };
    }
    case 'LOG_LEVEL': {
      const service = draft.service.trim();
      if (service === '' || (draft.level !== 'DEBUG' && draft.level !== 'TRACE' && draft.level !== 'INFO')) return null;
      return { type: 'LOG_LEVEL', reason, params: { service, level: draft.level } };
    }
    case 'FEATURE_OFF': {
      const flag = draft.flag.trim();
      return flag === '' ? null : { type: 'FEATURE_OFF', reason, params: { flag } };
    }
    case 'AUTOMATION_STOP':
      return { type: 'AUTOMATION_STOP', reason };
    case 'PG_ASSIGN': {
      if (!isUuidLike(draft.eventId)) return null;
      if (draft.primaryPg !== 'TOSS' && draft.primaryPg !== 'PORTONE') return null;
      if (draft.fallbackPg !== undefined && draft.fallbackPg !== 'TOSS' && draft.fallbackPg !== 'PORTONE') return null;
      if (draft.fallbackPg === draft.primaryPg) return null;
      return { type: 'PG_ASSIGN', reason, params: { eventId: draft.eventId, primaryPg: draft.primaryPg, ...(draft.fallbackPg ? { fallbackPg: draft.fallbackPg } : {}) } };
    }
  }
}

/** 명령 요청 화면 막힘: 명령 1은 operator 이상, 명령 3·6(전환·해제)은 commander만(control-tower §3 표), 휴대폰은 11만 허용(§12) */
export function commandAvailability(o: { role: ConsoleRole; layout: ConsoleLayoutKind; kind: CommandKind }): Availability {
  // 안전 쪽 조치인 명령 11은 휴대폰의 commander도 낼 수 있다(control-tower §12)
  if (o.kind === 'AUTOMATION_STOP') {
    return o.role === 'commander' ? { canRequest: true } : { canRequest: false, reason: '자동화 정지는 commander만 실행할 수 있습니다' };
  }
  if (o.layout === 'phone') return { canRequest: false, reason: PHONE_BLOCKED };
  if (o.kind === 'ADMISSION_TARGET') {
    return o.role === 'operator' || o.role === 'commander' ? { canRequest: true } : { canRequest: false, reason: '동시 입장 목표 조정은 operator 이상만 요청할 수 있습니다' };
  }
  if (o.kind === 'ADMISSION_PAUSE' || o.kind === 'BLOCK_ASN_IP' || o.kind === 'BOT_LEVEL' || o.kind === 'LOG_LEVEL' || o.kind === 'FEATURE_OFF' || o.kind === 'PG_ASSIGN') {
    return o.role === 'operator' || o.role === 'commander' ? { canRequest: true } : { canRequest: false, reason: `${COMMAND_NAMES[o.kind]}는 operator 이상만 요청할 수 있습니다` };
  }
  if (o.role === 'commander') return { canRequest: true };
  if (o.kind === 'KILL_SWITCH') return { canRequest: false, reason: '판매 일시정지는 commander만 실행할 수 있습니다' };
  if (o.kind === 'PG_ENTRY_RELEASE') return { canRequest: false, reason: '새 결제 진입 정지 열기는 commander만 실행할 수 있습니다' };
  return { canRequest: false, reason: '대체 결제사 전환은 commander만 요청할 수 있습니다' };
}

/**
 * 제출 하나(사용자 동작 하나)의 멱등 키(따옴표 없는 UUID v4, openapi IdempotencyKey). 같은 제출을 다시 보내면 같은 키,
 * 값을 바꿔 새로 보내면 화면이 새 Submission을 만든다(docs/frontend.md §4.1 '멱등 키', 계획 6-3).
 */
export class Submission {
  readonly idempotencyKey: string = crypto.randomUUID();
}
