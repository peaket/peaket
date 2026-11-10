// seatmap-worker 시작(core-svc 패키지의 다른 진입점, ADR-0257 결정 5). 실행 명령: node dist/seatmap-worker/main.js
// DB·Kafka·Redis·AWS 자격 증명 환경 값이 하나라도 있으면 뜨지 않는다(seat-hold ASVS 15.2.5). 저장소를 쓰지 않고 바깥을 부르지 않는다.
// 환경 값: PEAKET_GRPC_PORT(필수), PEAKET_GRPC_HOST(기본 0.0.0.0), PEAKET_SEATMAP_PARSE_TIMEOUT_MS(기본 5000), PEAKET_SEATMAP_HEAP_MB(기본 384), PEAKET_LOG_LEVEL
import { createPlatformLogger, LOG_LEVELS, type LogLevelName, systemClock } from '@peaket/platform';
import { forbiddenCredentialNames } from './credentials.js';
import { PARSE_TIMEOUT_MS, THREAD_HEAP_MB } from './pool.js';
import { startSeatmapWorker } from './server.js';

const SERVICE = 'seatmap-worker';
const env = process.env;

const forbidden = forbiddenCredentialNames(env);
if (forbidden.length > 0) throw new Error(`seatmap-worker는 자격 증명을 받지 않는다. 이 환경 값을 빼야 뜬다: ${forbidden.join(', ')}`);

function positive(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,6}$/.test(raw)) throw new Error(`${name}는 양의 정수여야 한다: ${raw}`);
  return Number(raw);
}

const rawPort = env.PEAKET_GRPC_PORT;
if (rawPort === undefined || !/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error(`PEAKET_GRPC_PORT가 없거나 틀렸다: ${rawPort ?? '(없음)'}`);
const rawLevel = env.PEAKET_LOG_LEVEL;
const level: LogLevelName = rawLevel && (LOG_LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevelName) : 'info';
const logger = createPlatformLogger({ service: SERVICE, env: env.PEAKET_ENV || 'prod', version: env.PEAKET_VERSION || 'unknown', clock: systemClock, level, ...(env.PEAKET_POD ? { pod: env.PEAKET_POD } : {}) });

const timeoutMs = positive('PEAKET_SEATMAP_PARSE_TIMEOUT_MS', PARSE_TIMEOUT_MS);
const heapMb = positive('PEAKET_SEATMAP_HEAP_MB', THREAD_HEAP_MB);
const server = await startSeatmapWorker({ host: env.PEAKET_GRPC_HOST || '0.0.0.0', port: Number(rawPort), logger, timeoutMs, heapMb });
logger.info({ event: 'seatmap_worker_started', port: server.port, timeoutMs, heapMb }, 'seatmap-worker를 띄웠다');

process.once('SIGTERM', () => {
  void server.close().finally(() => logger.info({ event: 'seatmap_worker_stopped' }, 'seatmap-worker를 닫았다'));
});
