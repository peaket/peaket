// 동결 달력 설정 읽기(F-02-3). 값이 없거나 꼴이 틀리면 ConfigError로 시작 전에 멈춘다.
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export const DEFAULT_SCHEDULE_KEY = 'ops-calendar/upcoming-onsales.json';

export function parseNowArg(argv: readonly string[]): number | null {
  const i = argv.indexOf('--now');
  if (i < 0) return Date.now();
  const text = argv[i + 1];
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`${name}가 없습니다`);
  return v;
}
