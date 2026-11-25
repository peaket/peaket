// 설정형 명령(5·8·9)의 매개변수 목록·사건 꼴·받는 서비스 표(F-02-5 OPS-300, ADR-0365 결정 9·10·13).
// 범위는 늘 PLATFORM이고, 실행·되돌리기·만료마다 사건 하나를 낸다. 목록 밖 값은 받는 쪽이 없어 '적용 확인됨'이
// 거짓이 되므로 접수 검사(checkCommandParams)와 사건 꼴 만들기(settingDraftOf) 두 곳에서 닫는다.
import { createHash } from 'node:crypto';
import { SAFETY_LIMITS, type Command, type CommandType } from './command.js';
import { checkCommandParams, type CommandInputRejected } from './command-params.js';

/** 설정형 명령(사건을 control.settings로 내는 명령) */
export const SETTING_COMMAND_TYPES = ['BOT_LEVEL', 'LOG_LEVEL', 'FEATURE_OFF'] as const;

/** 명령 8이 로그 레벨을 올릴 수 있는 서비스(설정 저장소의 키 PLATFORM:LOG_LEVEL:<서비스>를 읽는 쪽) */
export const LOG_LEVEL_SERVICES = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc'] as const;

/** 명령 8이 올릴 수 있는 수준(내리는 것은 만료·되돌리기의 INFO가 맡는다) */
export const LOG_LEVEL_RAISED = ['DEBUG', 'TRACE'] as const;

/** 명령 9가 끌 수 있는 기능 플래그(서버 쪽에 실제 끄는 쪽이 있는 것만) */
export const FEATURE_FLAGS = ['reviews'] as const;

/** 명령 5의 기본값(control-tower §3 명령 5, ADR-0365 결정 13) */
export const BOT_LEVEL_DEFAULT = Object.freeze({ level: 'STANDARD', reassessMode: 'SHADOW' });

/** 설정 사건의 단계: 실행(APPLY), 되돌리기(REVERT), 명령 8 자동 만료(EXPIRE) */
export type SettingPhase = 'APPLY' | 'REVERT' | 'EXPIRE';

/** 사건 하나의 초안. 만료가 있는 사건은 expires=true이고, 실제 expiresAt은 판 + SAFETY_LIMITS.logLevelMs다 */
export interface SettingDraft {
  readonly kind: string;
  readonly scope: 'PLATFORM';
  readonly target?: string;
  readonly value: Record<string, unknown>;
  readonly expires: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 명령 8의 사건 꼴: 실행은 {level}·만료 있음, 되돌리기·만료는 {level: INFO}·만료 없음 */
const logLevelDraft = (params: Record<string, unknown>, phase: SettingPhase): SettingDraft => {
  const { service } = checkCommandParams('LOG_LEVEL', params, 0) as { service: string };
  return {
    kind: 'LOG_LEVEL',
    scope: 'PLATFORM',
    target: service,
    value: { level: phase === 'APPLY' ? (params.level as string) : 'INFO' },
    expires: phase === 'APPLY',
  };
};

/** 명령 9의 사건 꼴: 실행 {enabled: false}, 되돌리기 {enabled: true}. 만료는 없다 */
const featureOffDraft = (params: Record<string, unknown>, phase: SettingPhase): SettingDraft => {
  const { flag } = checkCommandParams('FEATURE_OFF', params, 0) as { flag: string };
  return { kind: 'FEATURE_FLAG', scope: 'PLATFORM', target: flag, value: { enabled: phase !== 'APPLY' }, expires: false };
};

/** 명령 5의 사건 꼴: 실행은 {level, reassessMode}(없으면 SHADOW), 되돌리기는 직전 ACKED 값 또는 기본값 */
const botLevelDraft = (params: Record<string, unknown>, phase: SettingPhase, previousBotLevel?: Record<string, unknown>): SettingDraft => {
  const checked = checkCommandParams('BOT_LEVEL', params, 0) as { level: string; reassessMode?: string };
  const previous = isObject(previousBotLevel) ? previousBotLevel : undefined;
  const value =
    phase === 'APPLY'
      ? { level: checked.level, reassessMode: checked.reassessMode ?? 'SHADOW' }
      : previous !== undefined && typeof previous.level === 'string'
        ? { level: previous.level, reassessMode: typeof previous.reassessMode === 'string' ? previous.reassessMode : 'SHADOW' }
        : { ...BOT_LEVEL_DEFAULT };
  return { kind: 'BOT_LEVEL', scope: 'PLATFORM', value, expires: false };
};

/**
 * 설정형 명령의 사건 초안(ADR-0365 결정 13). 설정형이 아니면 undefined.
 * @throws CommandInputRejected 목록 밖 값(접수 검사를 지나지 않은 레거시 행도 여기서 막는다)
 */
export function settingDraftOf(
  command: Pick<Command, 'type' | 'params'>,
  phase: SettingPhase,
  o: { readonly previousBotLevel?: Record<string, unknown> } = {},
): SettingDraft | undefined {
  if (command.type === 'LOG_LEVEL') return logLevelDraft(command.params, phase);
  if (command.type === 'FEATURE_OFF') return featureOffDraft(command.params, phase);
  if (command.type === 'BOT_LEVEL') return botLevelDraft(command.params, phase, o.previousBotLevel);
  return undefined;
}

/** 설정 판 원장의 종류 칸: 'SETTING:<kind>:<target 또는 빈 글>' */
export const settingLedgerKindOf = (draft: SettingDraft): string => `SETTING:${draft.kind}:${draft.target ?? ''}`;

/** 메시지 키 '<범위>:<종류>:<대상>'(대상이 없으면 빈 글). 도메인 순수 함수라 어댑터가 아니라 여기 둔다 */
export const settingMessageKey = (s: { readonly scope: string; readonly kind: string; readonly target?: string }): string => `${s.scope}:${s.kind}:${s.target ?? ''}`;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 메시지 키가 가리키는 받는 서비스(ADR-0365 결정 10 표). 표 밖은 undefined.
 * LOG_LEVEL:<서비스>, FEATURE_FLAG:reviews→core-svc, BOT_LEVEL→trust-svc, <회차>:PG_ASSIGNMENT:→payment-svc
 */
export function settingReceiverOf(messageKey: string): string | undefined {
  if (messageKey.startsWith('PLATFORM:LOG_LEVEL:')) {
    const service = messageKey.slice('PLATFORM:LOG_LEVEL:'.length);
    return (LOG_LEVEL_SERVICES as readonly string[]).includes(service) ? service : undefined;
  }
  if (messageKey === 'PLATFORM:FEATURE_FLAG:reviews') return 'core-svc';
  if (messageKey === 'PLATFORM:BOT_LEVEL:') return 'trust-svc';
  const m = /^(.+):PG_ASSIGNMENT:$/.exec(messageKey);
  if (m && LOWER_UUID.test(m[1]!)) return 'payment-svc';
  return undefined;
}

/** 명령 8의 만료 길이(정본 30분). 새 상수를 두지 않고 기존 안전 한계를 쓴다 */
export const settingExpiryMs = (): number => SAFETY_LIMITS.logLevelMs;

/** 같은 끝이면 같은 commandId가 되게 끝 시각에서 UUID를 만든다(LOG_SAMPLING 중복 적용, C-T75 ④) */
export function deterministicUuidOf(seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 설정형 명령인가(사건을 내는 명령) */
export const isSettingCommand = (type: CommandType): boolean => (SETTING_COMMAND_TYPES as readonly CommandType[]).includes(type);

export type { CommandInputRejected };
