// BAT-032: 합본을 서비스별 자식 프로세스로 나눌 때 그 프로세스 하나를 띄우는 시작 파일.
//   node dist/service-worker.js payment-svc|purchase-svc|admission-ctrl|queue-svc [--hold]
// --hold는 purchase-svc에서 DB·Kafka를 빼고 PORT 8083/관리 9465로 띄운다(홀드 전용, 별도 이벤트 루프).
// 자식 프로세스인 까닭: Kafka 네이티브 모듈은 한 프로세스에서 한 번만 등록되고, 서비스마다 이벤트 루프를 하나씩 주기 위해서다.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BundleService } from './bundle.js';
import { parseEnvFile, serviceEnv } from './bundle.js';

type StartFn = (o: { env: Record<string, string | undefined>; onFatal?: (err: unknown) => void }) => Promise<{ close(): Promise<void> }>;

const name = process.argv[2];
const hold = process.argv.includes('--hold');
const SERVICES: readonly string[] = ['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc'];
if (!name || !SERVICES.includes(name)) throw new Error(`service-worker는 서비스 이름을 받아야 한다: ${SERVICES.join('·')}`);
if (hold && name !== 'purchase-svc') throw new Error('--hold는 purchase-svc에만 쓴다');

const envDir = process.env.PEAKET_BUNDLE_ENV_DIR;
if (!envDir) throw new Error('service-worker는 PEAKET_BUNDLE_ENV_DIR가 필요하다');

const common: Record<string, string | undefined> = { ...process.env };
const file = parseEnvFile(await readFile(join(envDir, `${name}.env`), 'utf8'), `${name}.env`);

if (hold) {
  // 홀드·세션 확인은 Redis와 좌석맵 판만 쓴다. DB·Kafka를 빼면 purchase-svc start()가
  // booking·Saga·발권·결과 소비자·상태 기다림 표·Kafka 소비자를 만들지 않는다.
  delete common.PEAKET_DATABASE_URL;
  delete common.PEAKET_KAFKA_BROKERS;
  delete file.PEAKET_DATABASE_URL;
  delete file.PEAKET_KAFKA_BROKERS;
  file.PORT = process.env.PEAKET_HOLD_PORT ?? '8083';
  file.PEAKET_MANAGEMENT_PORT = process.env.PEAKET_HOLD_MANAGEMENT_PORT ?? '9465';
}

const env = serviceEnv(name as BundleService, common, file);
const STARTERS: Record<string, () => Promise<StartFn>> = {
  'payment-svc': async () => (await import('@peaket/payment-svc/start')).start,
  'purchase-svc': async () => (await import('@peaket/purchase-svc/start')).start,
  'admission-ctrl': async () => (await import('@peaket/admission-ctrl/start')).start,
  'queue-svc': async () => (await import('@peaket/queue-svc/start')).start,
};

const start = await STARTERS[name]!();
let running: { close(): Promise<void> } | undefined;
running = await start({
  env,
  onFatal: (err) => {
    console.error(JSON.stringify({ level: 'error', service: hold ? 'hold-worker' : name, msg: '치명적 실패', err: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
    void running?.close();
  },
});
process.once('SIGTERM', () => void running?.close());
process.once('SIGINT', () => void running?.close());
console.log(JSON.stringify({ level: 'info', service: hold ? 'hold-worker' : name, port: Number(env.PORT), managementPort: Number(env.PEAKET_MANAGEMENT_PORT), msg: '서비스 프로세스를 켰다' }));
