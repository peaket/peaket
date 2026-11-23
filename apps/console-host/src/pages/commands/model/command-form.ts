// SCR-030 명령 1·3·6(결제 갈래) 작성 값 → 접수 본문, 화면 막힘, 멱등 키 묶음(F-03-4, OPS-390).
// 본문 칸은 openapi Command.params 설명(ADMISSION_TARGET {eventId, target, fromTarget}, KILL_SWITCH {scope, eventIds},
// DEGRADED_MODE 결제 갈래 {mode: PAYMENT_PG_FALLBACK, scope, eventIds, toPg})만 싣는다. 길이·범위·정규화 검사의 정본은 서버다(ADR-0340 결정 10).
// 막힘 글은 d5 §7.3 CMP-036 disabled 꼴, 휴대폰 막힘은 control-tower §12 '휴대폰·태블릿'. 화면 막힘은 편의이고 권한은 서버가 막는다(ASVS 8.3.1).

export type ConsoleRole = 'viewer' | 'operator' | 'commander' | (string & {});
export type ConsoleLayoutKind = 'phone' | 'tablet' | 'desktop';
export type CommandKind = 'ADMISSION_TARGET' | 'KILL_SWITCH' | 'PG_FALLBACK';
export type CommandScope = 'EVENT' | 'PLATFORM';
export type PgName = 'TOSS' | 'PORTONE';

export type CommandDraft =
  | { kind: 'ADMISSION_TARGET'; eventId: string; target: number; fromTarget?: number; reason: string }
  | { kind: 'KILL_SWITCH'; scope: CommandScope; eventId?: string; reason: string }
  | { kind: 'PG_FALLBACK'; scope: CommandScope; eventId?: string; toPg?: PgName; reason: string };

/** openapi Command(접수·dry-run 본문) */
export interface CommandBody {
  type: 'ADMISSION_TARGET' | 'KILL_SWITCH' | 'DEGRADED_MODE';
  reason: string;
  params: Record<string, unknown>;
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
};

export const PHONE_BLOCKED = '명령 요청과 실행은 태블릿이나 데스크톱에서 합니다';

const isUuidLike = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 회차 범위 칸: 이 회차면 eventIds: [회차], 전체면 칸 없이 scope만. 회차가 없으면 null */
function scopeParams(scope: CommandScope, eventId: string | undefined): Record<string, unknown> | null {
  if (scope === 'PLATFORM') return { scope: 'PLATFORM' };
  if (!isUuidLike(eventId)) return null;
  return { scope: 'EVENT', eventIds: [eventId] };
}

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
  }
}

/** 명령 요청 화면 막힘: 명령 1은 operator 이상, 명령 3·6은 commander만(control-tower §3 표), 휴대폰은 모두 막는다(§12) */
export function commandAvailability(o: { role: ConsoleRole; layout: ConsoleLayoutKind; kind: CommandKind }): Availability {
  if (o.layout === 'phone') return { canRequest: false, reason: PHONE_BLOCKED };
  if (o.kind === 'ADMISSION_TARGET') {
    return o.role === 'operator' || o.role === 'commander' ? { canRequest: true } : { canRequest: false, reason: '동시 입장 목표 조정은 operator 이상만 요청할 수 있습니다' };
  }
  if (o.role === 'commander') return { canRequest: true };
  return o.kind === 'KILL_SWITCH'
    ? { canRequest: false, reason: '판매 일시정지는 commander만 실행할 수 있습니다' }
    : { canRequest: false, reason: '대체 결제사 전환은 commander만 요청할 수 있습니다' };
}

/**
 * 제출 하나(사용자 동작 하나)의 멱등 키(따옴표 없는 UUID v4, openapi IdempotencyKey). 같은 제출을 다시 보내면 같은 키,
 * 값을 바꿔 새로 보내면 화면이 새 Submission을 만든다(docs/frontend.md §4.1 '멱등 키', 계획 6-3).
 */
export class Submission {
  readonly idempotencyKey: string = crypto.randomUUID();
}
