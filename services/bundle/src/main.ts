// 한 프로세스 합본 시작(docs/verification.md §3.8 (가), BUILD_ORDER PRF-215, ADR-0262 결정 4). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK는 프로세스에 하나라 서비스 이름은 OTEL_SERVICE_NAME 하나다. 성능 장부 notes에 적는다, docs/verification.md §3.8)
// 차례: 설정 검사(PEAKET_ENV local·ci 밖이면 여기서 던져 시작하지 않는다) → 합본 관리 포트(/livez·/ready·/metrics) → 서비스를 켜는 차례대로 켠다.
// SIGTERM: 서비스를 반대 차례로 닫은 뒤 관리 포트를 닫는다. 서비스 하나가 듣기 시작한 뒤 치명적으로 실패하면(Kafka 소비자를 켜지 못함) 모두 닫고 종료 코드 1로 끝낸다.
import { createPlatformLogger, errorSummary, loadPlatformConfig, systemClock } from '@peaket/platform';
import { loadBundleConfig, type RunningBundle, startBundle } from './bundle.js';
import { startManagement } from './management.js';

const config = loadBundleConfig(process.env);
const platform = loadPlatformConfig(process.env);
const logger = createPlatformLogger({ service: 'bundle', env: platform.env, version: platform.version, az: process.env.PEAKET_AZ, pod: process.env.PEAKET_POD, clock: systemClock, level: platform.logLevel });

let running: RunningBundle | undefined;
const management = await startManagement(config.managementPort, {
  pending: () => (running ? [] : config.services),
  services: () => running?.services ?? [],
});
logger.info({ services: config.services, managementPort: management.port }, '합본 관리 포트를 열었다');

// SIGTERM 처리기는 서비스를 켜기 전에 건다: 켜는 중에 오면 startBundle이 켠 것을 닫고 던진다(코드 리뷰 낮음)
const stop = new AbortController();
let closing: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  closing ??= (async () => {
    // 닫는 데 걸린 시간(ms)을 적는다: 종료 유예(deploy/envs/local/v1-bundle.yaml 60초)를 맞추는 근거(코드 리뷰)
    const startedMs = performance.now();
    await running?.close();
    await management.close();
    logger.info({ services: config.services, closeMs: Math.round(performance.now() - startedMs) }, '합본을 닫았다');
  })();
  return closing;
};

process.once('SIGTERM', () => {
  stop.abort();
  // 켜는 중이면 startBundle이 켠 것을 닫고 던진다(아래 catch). 다 켠 뒤면 반대 차례로 닫는다
  if (running) void shutdown();
});

try {
  running = await startBundle({
    config,
    stop: stop.signal,
    onFatal: (service, err) => {
      logger.error({ target: service, err: errorSummary(err) }, '서비스 하나가 실패해 합본을 끝낸다');
      process.exitCode = 1;
      void shutdown();
    },
    // 로그 줄의 service는 bundle이고 그 서비스 이름은 target에 싣는다
    log: (e) => (e.step === 'close-failed' ? logger.error({ target: e.service, err: errorSummary(e.err) }, '서비스 닫기 실패(나머지는 닫는다)') : logger.info({ target: e.service, step: e.step }, '합본 서비스')),
  });
} catch (err) {
  await management.close();
  if (stop.signal.aborted) {
    logger.info({ services: config.services }, '켜는 중에 SIGTERM을 받아 켠 서비스를 닫았다');
    process.exit();
  }
  throw err;
}
if (stop.signal.aborted) void shutdown();
else logger.info({ services: running.services }, '합본의 서비스를 모두 켰다');
