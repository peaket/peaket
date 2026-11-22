// 시작 파일을 실제로 띄우는 시험의 공용 준비(ADR-0249 결정 4). 운영 환경 값으로 띄우고 관리 포트를 돌려준다.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceControlSyncOptions, startServiceControlSync } from '@peaket/platform/stream-worker';
import { vi } from 'vitest';
import { SYNTHETIC_RULES_JSON } from '../test/support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** 시작 파일이 제어 설정 동기화 도우미를 부른 한 번(가짜로 바꿨을 때만 모인다) */
export interface ControlSyncCall {
  service: string;
  options: ServiceControlSyncOptions | undefined;
  peaketEnv: string | undefined;
  /** 넘긴 env가 프로세스 환경 그 자체인가 */
  envIsProcessEnv: boolean;
  /** 부를 때 업무·관리 포트 가운데 하나라도 이미 듣고 있었나(listen 전이어야 한다) */
  listening: boolean;
}

/**
 * realControlSync: 운영 값에서도 제어 설정 동기화를 진짜로 둔다(브로커가 없으면 시작에 실패하는 것을 보는 main-no-broker만 쓴다)
 */
export async function bootMain(extraEnv: Record<string, string>, o: { realControlSync?: boolean } = {}): Promise<{ valkey: ValkeyContainer; managementPort: number; grpcPort: number; controlSyncCalls: ControlSyncCall[] }> {
  const valkey = startValkey();
  const dir = mkdtempSync(join(tmpdir(), 'trust-main-'));
  const rulesFile = join(dir, 'rules.json');
  writeFileSync(rulesFile, SYNTHETIC_RULES_JSON);
  const managementPort = await freePort();
  const grpcPort = await freePort();
  delete process.env.PEAKET_TELEMETRY_KAFKA_BROKERS;
  const env: Record<string, string> = {
    PEAKET_ENV: 'prod',
    PEAKET_TRUST_REDIS_URL: valkey.url,
    PEAKET_TRUST_RULES_FILE: rulesFile,
    PEAKET_GRPC_PORT: String(grpcPort),
    PEAKET_GRPC_HOST: '127.0.0.1',
    PORT: String(await freePort()),
    PEAKET_MANAGEMENT_PORT: String(managementPort),
    PEAKET_TURNSTILE_SECRET: 'test-secret-value',
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
    PEAKET_LOG_LEVEL: 'fatal',
    ...extraEnv,
  };
  // R-608: prod/staging 기동은 내부 gRPC 토큰을 요구한다. ci/local 시험은 토큰 없이 부른다.
  if ((env.PEAKET_ENV === 'prod' || env.PEAKET_ENV === 'staging') && !env.PEAKET_INTERNAL_GRPC_TOKEN) env.PEAKET_INTERNAL_GRPC_TOKEN = 'test-internal-grpc-token';
  Object.assign(process.env, env);
  const controlSyncCalls: ControlSyncCall[] = [];
  if (!o.realControlSync && (env.PEAKET_ENV === 'prod' || env.PEAKET_ENV === 'staging') && !env.PEAKET_KAFKA_BROKERS) {
    // 운영 값에서는 제어 설정 토픽(control.settings) 소비에 브로커 주소와 MSK IAM 인증이 함께 있어야 한다(평문 브로커는 local·ci만,
    // packages/platform/src/msk-iam.ts kafkaAuthFromEnv, ADR-0334 결정 2). 이 PC·CI에서는 진짜로 띄울 수 없어, 운영 값으로 띄우는 이 시험들에서만
    // 제어 설정 동기화 도우미 하나를 바꾸고 다른 내보내기(텔레메트리 생산자 등)는 진짜 그대로 둔다. 가짜는 받은 인자를 적고, 진짜가 꺼진 설정에서 돌려주는
    // undefined를 돌려준다(시작 파일은 controlSync?.close()로만 쓴다). 진짜 동작은 packages/platform test-int/control-sync.int.test.ts(C-T75 ②⑤)가
    // 실제 Kafka로 보고, '브로커가 없으면 시작하지 않는다'는 main-no-broker.int.test.ts가 보며, 호출 모양은 main-start 시험이 controlSyncCalls로 본다(BAT-215 RV215-3)
    const fake = vi.fn<typeof startServiceControlSync>((service, passed, options) => {
      controlSyncCalls.push({
        service: service.name,
        options,
        peaketEnv: passed.PEAKET_ENV,
        envIsProcessEnv: passed === process.env,
        listening: service.http.server.listening || service.management.server.listening,
      });
      return undefined;
    });
    vi.doMock('@peaket/platform/stream-worker', async (importOriginal) => ({ ...(await importOriginal<typeof import('@peaket/platform/stream-worker')>()), startServiceControlSync: fake }));
  }
  try {
    await import('../src/main.js');
  } catch (err) {
    valkey.stop();
    throw err;
  }
  return { valkey, managementPort, grpcPort, controlSyncCalls };
}
