// 합본 시작(docs/verification.md §3.8, BUILD_ORDER PRF-215, ADR-0262 결정 4).
// - 기본(single): 한 프로세스에 PEAKET_BUNDLE_SERVICES를 모두 띄운다(BAT-031까지의 무대).
// - PEAKET_BUNDLE_MODE=split: payment-svc·purchase-svc(전체)·purchase-svc(홀드 전용)를 자식 프로세스로 나누고,
//   이 프로세스는 admission-ctrl·queue-svc만 띄운다(BAT-032). 서비스마다 이벤트 루프가 하나씩 생긴다.
// - 어느 모드든 관리 포트(/livez·/ready·/metrics)는 이 프로세스 하나가 열고, 서비스들의 관리 포트를 모아 /ready와 /metrics를 합친다.
// SIGTERM: 자식 프로세스에 SIGTERM을 보내고 5초 뒤에도 안 끝나면 SIGKILL, 그 뒤 관리 포트를 닫는다.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlatformLogger, errorSummary, loadPlatformConfig, systemClock } from '@peaket/platform';
import { type BundleConfig, type BundleService, loadBundleConfig, parseEnvFile, type RunningBundle, startBundle } from './bundle.js';
import { startManagement } from './management.js';

/** 홀드 전용 purchase-svc의 앱 포트(차트 Service가 연다)와 관리 포트(합본이 /ready·/metrics로 모은다) */
const HOLD_PORT = 8083;
const HOLD_MANAGEMENT_PORT = 9465;

const config = loadBundleConfig(process.env);
const platform = loadPlatformConfig(process.env);
const split = process.env.PEAKET_BUNDLE_MODE === 'split';
const logger = createPlatformLogger({ service: 'bundle', env: platform.env, version: platform.version, az: process.env.PEAKET_AZ, pod: process.env.PEAKET_POD, clock: systemClock, level: platform.logLevel });

interface ChildEntry {
  name: string;
  child: ChildProcess;
  managementPort: number;
}

let running: RunningBundle | undefined;
const children: ChildEntry[] = [];
let closing: Promise<void> | undefined;

const management = await startManagement(config.managementPort, {
  pending: () => [
    ...(running ? [] : split ? ['admission-ctrl', 'queue-svc'] : config.services),
    ...(split ? (children.length >= 3 ? [] : ['payment-svc', 'purchase-svc', 'hold-worker']) : children.length >= 1 ? [] : ['hold-worker']),
  ],
  services: () => [...(running?.services ?? []), ...children.map((c) => ({ service: c.name, managementPort: c.managementPort }))],
});
logger.info({ mode: split ? 'split' : 'single', services: config.services, holdPort: HOLD_PORT, managementPort: management.port }, '합본 관리 포트를 열었다');

// SIGTERM 처리기는 서비스를 켜기 전에 건다: 켜는 중에 오면 startBundle이 켠 것을 닫고 던진다(코드 리뷰 낮음)
const stop = new AbortController();
const stopChild = async (c: ChildEntry): Promise<void> => {
  if (c.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => c.child.once('exit', () => resolve()));
  c.child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (c.child.exitCode === null) c.child.kill('SIGKILL');
};
const shutdown = (): Promise<void> => {
  closing ??= (async () => {
    // 닫는 데 걸린 시간(ms)을 적는다: 종료 유예(deploy/envs/local/v1-bundle.yaml 60초)를 맞추는 근거(코드 리뷰)
    const startedMs = performance.now();
    await running?.close();
    for (const c of [...children].reverse()) await stopChild(c);
    children.length = 0;
    await management.close();
    logger.info({ mode: split ? 'split' : 'single', closeMs: Math.round(performance.now() - startedMs) }, '합본을 닫았다');
  })();
  return closing;
};

/** 서비스 하나를 자식 프로세스로 띄운다. service-worker가 그 서비스의 환경 파일을 읽어 start()를 부른다 */
const spawnChild = (name: string, args: string[], managementPort: number, extraEnv: Record<string, string> = {}): void => {
  const child = spawn(process.execPath, ['--import', '@peaket/platform/telemetry/register', fileURLToPath(new URL('./service-worker.js', import.meta.url)), ...args], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.once('error', (err) => {
    logger.error({ target: name, err: errorSummary(err) }, '서비스 프로세스를 띄우지 못해 합본을 끝낸다');
    process.exitCode = 1;
    void shutdown();
  });
  child.once('exit', (code, signal) => {
    if (closing) return;
    logger.error({ target: name, code, signal }, '서비스 프로세스가 예기치 않게 끝나 합본을 끝낸다');
    process.exitCode = 1;
    void shutdown();
  });
  children.push({ name, child, managementPort });
};

const spawnHold = (): void => {
  spawnChild('hold-worker', ['purchase-svc', '--hold'], HOLD_MANAGEMENT_PORT, {
    PEAKET_HOLD_PORT: String(HOLD_PORT),
    PEAKET_HOLD_MANAGEMENT_PORT: String(HOLD_MANAGEMENT_PORT),
  });
};

const managementPortOf = async (service: string): Promise<number> => {
  const file = parseEnvFile(await readFile(join(config.envDir, `${service}.env`), 'utf8'), `${service}.env`);
  const port = Number(file.PEAKET_MANAGEMENT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${service}.env의 PEAKET_MANAGEMENT_PORT가 틀렸다`);
  return port;
};

process.once('SIGTERM', () => {
  stop.abort();
  // 켜는 중이면 startBundle이 켠 것을 닫고 던진다(아래 catch). 다 켠 뒤면 반대 차례로 닫는다
  if (running || children.length > 0) void shutdown();
});

try {
  if (split) {
    // BAT-032: 결제와 구매(주문·Saga·결과 소비자·상태)를 각자의 이벤트 루프로 보낸다.
    // 홀드는 purchase-svc를 DB·Kafka 없이 한 번 더 띄워 8083에서 받는다.
    spawnChild('payment-svc', ['payment-svc'], await managementPortOf('payment-svc'));
    spawnChild('purchase-svc', ['purchase-svc'], await managementPortOf('purchase-svc'));
    spawnHold();
    const mainConfig: BundleConfig = { ...config, services: ['admission-ctrl', 'queue-svc'] as BundleService[] };
    running = await startBundle({
      config: mainConfig,
      stop: stop.signal,
      onFatal: (service, err) => {
        logger.error({ target: service, err: errorSummary(err) }, '서비스 하나가 실패해 합본을 끝낸다');
        process.exitCode = 1;
        void shutdown();
      },
      log: (e) => (e.step === 'close-failed' ? logger.error({ target: e.service, err: errorSummary(e.err) }, '서비스 닫기 실패(나머지는 닫는다)') : logger.info({ target: e.service, step: e.step }, '합본 서비스')),
    });
  } else {
    running = await startBundle({
      config,
      stop: stop.signal,
      onFatal: (service, err) => {
        logger.error({ target: service, err: errorSummary(err) }, '서비스 하나가 실패해 합본을 끝낸다');
        process.exitCode = 1;
        void shutdown();
      },
      log: (e) => (e.step === 'close-failed' ? logger.error({ target: e.service, err: errorSummary(e.err) }, '서비스 닫기 실패(나머지는 닫는다)') : logger.info({ target: e.service, step: e.step }, '합본 서비스')),
    });
    spawnHold();
  }
} catch (err) {
  await shutdown();
  if (stop.signal.aborted) {
    logger.info({ services: config.services }, '켜는 중에 SIGTERM을 받아 켠 서비스를 닫았다');
    process.exit();
  }
  throw err;
}
if (stop.signal.aborted) void shutdown();
else logger.info({ mode: split ? 'split' : 'single', services: running.services }, '합본의 서비스를 모두 켰다');
