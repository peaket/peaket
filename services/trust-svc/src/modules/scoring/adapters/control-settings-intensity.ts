// 빈 뼈대(F-02-5 확인용): 심볼과 꼴만 있고 셈은 아직 없다. 다음 구현 커밋이 실제 값을 채운다.
export const BOT_LEVEL_SETTING_KEY = 'PLATFORM:BOT_LEVEL:';

export function intensityOfBotLevel(_value: unknown): string {
  return 'BASE';
}

export function bindBotLevelSetting(_settings: unknown, _book: unknown, _log?: unknown): () => void {
  return () => {};
}
