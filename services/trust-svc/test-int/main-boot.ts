// 시작 파일을 실제로 띄우는 시험의 공용 준비(ADR-0249 결정 4). 운영 환경 값으로 띄우고 관리 포트를 돌려준다.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export async function bootMain(extraEnv: Record<string, string>): Promise<{ valkey: ValkeyContainer; managementPort: number }> {
  const valkey = startValkey();
  const dir = mkdtempSync(join(tmpdir(), 'trust-main-'));
  const rulesFile = join(dir, 'rules.json');
  writeFileSync(rulesFile, SYNTHETIC_RULES_JSON);
  const managementPort = await freePort();
  delete process.env.PEAKET_TELEMETRY_KAFKA_BROKERS;
  Object.assign(process.env, {
    PEAKET_ENV: 'prod',
    PEAKET_TRUST_REDIS_URL: valkey.url,
    PEAKET_TRUST_RULES_FILE: rulesFile,
    PEAKET_GRPC_PORT: String(await freePort()),
    PEAKET_GRPC_HOST: '127.0.0.1',
    PORT: String(await freePort()),
    PEAKET_MANAGEMENT_PORT: String(managementPort),
    PEAKET_TURNSTILE_SECRET: 'test-secret-value',
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
    PEAKET_LOG_LEVEL: 'fatal',
    ...extraEnv,
  });
  try {
    await import('../src/main.js');
  } catch (err) {
    valkey.stop();
    throw err;
  }
  return { valkey, managementPort };
}
