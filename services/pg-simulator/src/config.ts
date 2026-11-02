// 시뮬레이터 실행 설정(환경 값). 운영에서는 시작하지 않는다: PEAKET_ENV가 없으면 운영으로 본다(packages/platform과 같은 기본값).
// 키는 시험 키(sim_sk_)만 받는다. 토스의 test_sk_·live_와 이름부터 달라 실제 결제사 키가 섞이지 않는다(payment §2.1 '테스트 자격증명').
import { DEFAULT_CONFIRM_LATENCY, type LatencySpec } from './latency.js';

export const SIMULATOR_ENVS = ['local', 'ci', 'demo', 'staging'] as const;
export const SECRET_KEY = /^sim_sk_[A-Za-z0-9_-]{16,}$/;

export interface SimulatorConfig {
  secretKey: string;
  host: string;
  port: number;
  seed: number | undefined;
  confirmLatency: LatencySpec;
}

export class SimulatorConfigError extends Error {
  override name = 'SimulatorConfigError';
}

export function loadSimulatorConfig(env: Readonly<Record<string, string | undefined>>): SimulatorConfig {
  const peaketEnv = env.PEAKET_ENV;
  if (!peaketEnv || !(SIMULATOR_ENVS as readonly string[]).includes(peaketEnv)) {
    throw new SimulatorConfigError(`PEAKET_ENV가 ${SIMULATOR_ENVS.join('·')} 가운데 하나일 때만 시작한다(운영에서는 띄우지 않는다): ${peaketEnv ?? '(없음)'}`);
  }
  const secretKey = env.PG_SIMULATOR_SECRET_KEY;
  if (!secretKey) throw new SimulatorConfigError('PG_SIMULATOR_SECRET_KEY가 없다');
  if (!SECRET_KEY.test(secretKey)) throw new SimulatorConfigError('PG_SIMULATOR_SECRET_KEY는 sim_sk_ 뒤에 16자 이상(영문·숫자·_·-)이어야 한다');
  const port = env.PG_SIMULATOR_PORT === undefined ? 8790 : Number(env.PG_SIMULATOR_PORT);
  if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) throw new SimulatorConfigError(`PG_SIMULATOR_PORT가 포트 번호가 아니다: ${env.PG_SIMULATOR_PORT}`);
  const seed = env.PG_SIMULATOR_SEED === undefined ? undefined : Number(env.PG_SIMULATOR_SEED);
  if (seed !== undefined && !Number.isSafeInteger(seed)) throw new SimulatorConfigError(`PG_SIMULATOR_SEED가 정수가 아니다: ${env.PG_SIMULATOR_SEED}`);
  return { secretKey, host: env.PG_SIMULATOR_HOST || '127.0.0.1', port, seed, confirmLatency: parseLatencyEnv(env.PG_SIMULATOR_LATENCY) };
}

/** default | none | fixed:<ms> | lognormal:<중앙값 ms>:<p99 ms> */
function parseLatencyEnv(v: string | undefined): LatencySpec {
  if (v === undefined || v === '' || v === 'default') return DEFAULT_CONFIRM_LATENCY;
  if (v === 'none') return { kind: 'none' };
  const fixed = /^fixed:(\d+)$/.exec(v);
  if (fixed) return { kind: 'fixed', ms: Number(fixed[1]) };
  const logn = /^lognormal:(\d+):(\d+)$/.exec(v);
  if (logn && Number(logn[2]) > Number(logn[1]) && Number(logn[1]) > 0) return { kind: 'lognormal', medianMs: Number(logn[1]), p99Ms: Number(logn[2]) };
  throw new SimulatorConfigError(`PG_SIMULATOR_LATENCY가 틀렸다(default·none·fixed:<ms>·lognormal:<중앙값>:<p99>): ${v}`);
}
