// 시작 설정 검사(ASVS v5.0.0-13.4.2, ADR-0081, docs/api/guidelines.md §2, openspec 변경 add-service-template 결정 3).
// 잘못된 설정은 시작을 막는다. 환경 이름이 없으면 운영으로 본다(닫힘 실패).
import { DEFAULT_MAX_DEADLINE_MS } from './deadline.js';

export const PEAKET_ENVS = ['local', 'ci', 'demo', 'staging', 'prod'] as const;
export type PeaketEnv = (typeof PEAKET_ENVS)[number];
/** Problem의 debug 확장을 켤 수 있는 환경 */
export const DEBUG_ERRORS_ALLOWED: readonly PeaketEnv[] = ['local', 'ci'];

export interface PlatformConfig {
  env: PeaketEnv;
  debugErrors: boolean;
  /** 앱 요청을 받는 포트 */
  port: number;
  /** 지표(/metrics)를 내는 관리 포트. 앱 포트와 달라야 한다(ASVS v5.0.0-13.4.5) */
  managementPort: number;
  /** 받은 남은 시간의 상한(밀리초, guidelines §5) */
  maxDeadlineMs: number;
  /** 배포한 판(PEAKET_VERSION, 없으면 unknown). 정규 로그 줄의 version */
  version: string;
  /** 서비스 로거 수준(PEAKET_LOG_LEVEL). 정규 로그 줄은 이 값과 관계없이 info부터 낸다 */
  logLevel: LogLevelName;
  /** 정상 줄 표본 비율 'N건에 1건'의 처음 값(PEAKET_LOG_SAMPLE_ONE_IN, 기본 10 = 평시 10%) */
  sampleOneIn: number;
  /** 경로에 SLO 지연을 적지 않았을 때의 기준(PEAKET_LOG_SLO_LATENCY_MS, 기본 NFR-011의 500ms). 넘은 요청은 전수로 남긴다 */
  defaultSloLatencyMs: number;
}

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export class PlatformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConfigError';
  }
}

type Env = Record<string, string | undefined>;

function port(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) throw new PlatformConfigError(`${name}은(는) 0~65535의 포트 번호여야 한다: ${v}`);
  return Number(v);
}

export function loadPlatformConfig(env: Env): PlatformConfig {
  const rawEnv = env.PEAKET_ENV;
  if (rawEnv !== undefined && rawEnv !== '' && !(PEAKET_ENVS as readonly string[]).includes(rawEnv)) {
    throw new PlatformConfigError(`PEAKET_ENV는 ${PEAKET_ENVS.join('·')} 가운데 하나여야 한다: ${rawEnv}`);
  }
  const peaketEnv = (rawEnv || 'prod') as PeaketEnv;

  const rawDebug = env.PEAKET_DEBUG_ERRORS;
  if (rawDebug !== undefined && rawDebug !== '' && rawDebug !== 'true' && rawDebug !== 'false') {
    throw new PlatformConfigError(`PEAKET_DEBUG_ERRORS는 true·false 가운데 하나여야 한다: ${rawDebug}`);
  }
  const debugErrors = rawDebug === 'true';
  if (debugErrors && !DEBUG_ERRORS_ALLOWED.includes(peaketEnv)) {
    throw new PlatformConfigError(
      `PEAKET_DEBUG_ERRORS=true는 ${DEBUG_ERRORS_ALLOWED.join('·')}에서만 켤 수 있다(지금 ${rawEnv ? peaketEnv : '환경 없음(운영으로 봄)'}, ASVS v5.0.0-13.4.2)`,
    );
  }

  const appPort = port(env, 'PORT', 8080);
  const managementPort = port(env, 'PEAKET_MANAGEMENT_PORT', 9464);
  if (appPort !== 0 && appPort === managementPort) throw new PlatformConfigError(`앱 포트와 관리 포트가 같다: ${appPort}`);

  const rawMax = env.PEAKET_MAX_DEADLINE_MS;
  let maxDeadlineMs = DEFAULT_MAX_DEADLINE_MS;
  if (rawMax !== undefined && rawMax !== '') {
    if (!/^[1-9]\d{0,8}$/.test(rawMax)) throw new PlatformConfigError(`PEAKET_MAX_DEADLINE_MS는 양의 정수(밀리초)여야 한다: ${rawMax}`);
    maxDeadlineMs = Number(rawMax);
  }
  const version = env.PEAKET_VERSION || 'unknown';
  const rawLevel = env.PEAKET_LOG_LEVEL;
  if (rawLevel !== undefined && rawLevel !== '' && !(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    throw new PlatformConfigError(`PEAKET_LOG_LEVEL은 ${LOG_LEVELS.join('·')} 가운데 하나여야 한다: ${rawLevel}`);
  }
  const logLevel = (rawLevel || 'info') as LogLevelName;
  const sampleOneIn = positiveInt(env, 'PEAKET_LOG_SAMPLE_ONE_IN', 10);
  const defaultSloLatencyMs = positiveInt(env, 'PEAKET_LOG_SLO_LATENCY_MS', 500);
  return { env: peaketEnv, debugErrors, port: appPort, managementPort, maxDeadlineMs, version, logLevel, sampleOneIn, defaultSloLatencyMs };
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^[1-9]\d{0,8}$/.test(v)) throw new PlatformConfigError(`${name}은(는) 양의 정수여야 한다: ${v}`);
  return Number(v);
}
