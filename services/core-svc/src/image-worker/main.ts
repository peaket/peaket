// F-10-2 image-worker 시작(core-svc 패키지의 다른 진입점, 계획 docs/review/plans/F-10-2.md E1·§5, ADR-0130, D-T35).
// 실행 명령: node dist/image-worker/main.js. DB·Kafka·Redis 자격 증명이 있으면 뜨지 않는다. AWS S3 자격 증명은 받는다.
// 자격 증명 확인은 무거운 모듈을 싣기 전에 한다(잘못된 배포가 빨리 끝나고 로그가 남게).
import { writeSync } from 'node:fs';
import { forbiddenCredentialNames } from './credentials.js';

const SERVICE = 'image-worker';
const env = process.env;

function fail(message: string): never {
  // 시험은 자식 프로세스의 출력을 끝 코드와 함께 본다. 파이프로 비동기로 쓰이기 전에 끝나지 않도록 동기로 쓴다.
  writeSync(2, `${message}\n`);
  process.exit(1);
}

const forbidden = forbiddenCredentialNames(env);
if (forbidden.length > 0) fail(`image-worker는 자격 증명을 받지 않는다. 이 환경 값을 빼야 뜬다: ${forbidden.join(', ')}`);

function required(name: string): string {
  const v = env[name];
  if (!v) fail(`${name}이 없다`);
  return v;
}
function positive(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,8}$/.test(raw)) fail(`${name}는 양의 정수여야 한다: ${raw}`);
  return Number(raw);
}

const rawPort = required('PEAKET_GRPC_PORT');
if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) fail(`PEAKET_GRPC_PORT가 틀렸다: ${rawPort}`);
const concurrency = positive('PEAKET_IMAGE_CONCURRENCY', 1);
if (concurrency !== 1) fail(`PEAKET_IMAGE_CONCURRENCY는 1만 받는다: ${concurrency}`);

const { createPlatformLogger, LOG_LEVELS, systemClock } = await import('@peaket/platform');
const { S3WorkerStore } = await import('./s3.js');
const { startImageWorker } = await import('./server.js');
const rawLevel = env.PEAKET_LOG_LEVEL;
const level = rawLevel && (LOG_LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as (typeof LOG_LEVELS)[number]) : 'info';
const logger = createPlatformLogger({ service: SERVICE, env: env.PEAKET_ENV || 'prod', version: env.PEAKET_VERSION || 'unknown', clock: systemClock, level, ...(env.PEAKET_POD ? { pod: env.PEAKET_POD } : {}) });

const store = new S3WorkerStore({
  bucket: required('PEAKET_IMAGE_BUCKET'),
  region: required('PEAKET_IMAGE_S3_REGION'),
  ...(env.PEAKET_IMAGE_S3_ENDPOINT ? { endpoint: env.PEAKET_IMAGE_S3_ENDPOINT } : {}),
});
await store.ready();
const timeoutMs = positive('PEAKET_IMAGE_TIMEOUT_MS', 30_000);
const maxPixels = positive('PEAKET_IMAGE_MAX_PIXELS', 40_000_000);
const server = await startImageWorker({ host: env.PEAKET_GRPC_HOST || '0.0.0.0', port: Number(rawPort), store, logger, timeoutMs, maxPixels });
logger.info({ event: 'image_worker_started', port: server.port, timeoutMs, maxPixels, concurrency }, 'image-worker를 띄웠다');

process.once('SIGTERM', () => {
  void server.close().finally(() => logger.info({ event: 'image_worker_stopped' }, 'image-worker를 닫았다'));
});
