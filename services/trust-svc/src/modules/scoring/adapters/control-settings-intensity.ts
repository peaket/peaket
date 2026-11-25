// 명령 5(봇 판정 강도)의 trust-svc 읽는 쪽(F-02-5 OPS-300, ADR-0365 결정 19, bot-defense §4.4 '설정 읽기').
// 설정 저장소의 'PLATFORM:BOT_LEVEL:' 바뀜을 규칙 묶음의 강도로 잇는다. 값 없음·만료·꼴 틀림은 BASE이고,
// 꼴 틀림·모르는 강도는 경고 한 줄만 남기고 판정을 멈추지 않는다.
import type { SettingsStore, SettingEntry } from '@peaket/platform';
import type { Intensity } from '../domain/types.js';

export const BOT_LEVEL_SETTING_KEY = 'PLATFORM:BOT_LEVEL:';

/** 계약 강도(RELAXED·STANDARD·AGGRESSIVE)를 규칙 강도 이름(RELAXED·BASE·STRICT)으로 잇는다 */
export function intensityOfBotLevel(value: unknown): Intensity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'BASE';
  const level = (value as { level?: unknown }).level;
  if (level === 'RELAXED') return 'RELAXED';
  if (level === 'STANDARD') return 'BASE';
  if (level === 'AGGRESSIVE') return 'STRICT';
  return 'BASE';
}

const invalid = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
  const level = (value as { level?: unknown }).level;
  return level !== 'RELAXED' && level !== 'STANDARD' && level !== 'AGGRESSIVE';
};

/**
 * 설정 저장소의 BOT_LEVEL 바뀜을 규칙 묶음 강도에 잇는다. 지금 값을 바로 반영하고, 돌려준 함수가 끊는다.
 * 한 요청은 ScoreRisk가 시작할 때 한 번만 강도를 읽으므로 요청 도중 바뀜은 다음 요청부터 적용된다.
 */
export function bindBotLevelSetting(
  settings: Pick<SettingsStore, 'get' | 'onChange'>,
  rules: { setIntensity(next: Intensity): void },
  log?: { warn(o: object, m: string): void },
): () => void {
  const apply = (entry: SettingEntry | undefined): void => {
    if (entry === undefined) {
      rules.setIntensity('BASE');
      return;
    }
    if (invalid(entry.value)) {
      rules.setIntensity('BASE');
      log?.warn({ key: BOT_LEVEL_SETTING_KEY, version: entry.version, reason: 'invalid-bot-level' }, 'BOT_LEVEL 설정 값이 계약 꼴이 아니어서 기본 강도(BASE)를 쓴다');
      return;
    }
    rules.setIntensity(intensityOfBotLevel(entry.value));
  };

  apply(settings.get(BOT_LEVEL_SETTING_KEY));
  const off = settings.onChange((key, entry) => {
    if (key === BOT_LEVEL_SETTING_KEY) apply(entry);
  });
  return off;
}
