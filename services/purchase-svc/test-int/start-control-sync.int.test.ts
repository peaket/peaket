// purchase-svc 시작 함수(src/start.ts)가 듣기 전에 종료 세션 목록 소비를 켜는지 실제 시작으로 본다
// (docs/features/identity.md §3 '서비스에 잇기'·§12 I-T3 ②, ADR-0333 결정 2, BUILD_ORDER HOT-401 묶음 BAT-059).
// 시험 조립이 아니라 start()를 띄운다. 브로커 주소는 ci 환경에서 닿지 않는 곳이라, 종료 세션 창을 다 읽기 전인 /ready는 503이고 남은 작업에 sessions가 있어야 한다.
// DB 주소를 주지 않아 업무 Kafka 소비자는 켜지지 않는다(제어 토픽 소비만 브로커 주소를 쓴다). 실제 Valkey.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { start, type StartedService } from '../src/start.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let svc: StartedService | undefined;
let seatDir: string;
let managementPort = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const ecdhJwk = (() => {
  const j = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'it-ecdh-t3' };
})();

beforeAll(async () => {
  valkey = await startValkey();
  seatDir = await mkdtemp(join(tmpdir(), 'peaket-bat059-'));
  managementPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_KAFKA_BROKERS: `127.0.0.1:${await freePort()}`,
      PEAKET_POD: 'pod-unreachable',
      PEAKET_SEAT_REDIS_URL: valkey.url,
      PEAKET_ADMISSION_JWKS_URL: `http://127.0.0.1:${await freePort()}/internal/jwks/admission.json`,
      PEAKET_ADMISSION_ISSUER: 'https://queue.peaket.example',
      PEAKET_SEATMAP_DIR: seatDir,
      PEAKET_PURCHASE_ECDH_KEY: JSON.stringify(ecdhJwk),
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
}, 120_000);

afterAll(async () => {
  await svc?.close();
  valkey?.stop();
  if (seatDir) await rm(seatDir, { recursive: true, force: true });
});

test('I-T3 ②-11 purchase-svc 시작 함수는 듣기 전에 종료 세션 목록 소비를 켜, 브로커가 닿지 않는 동안 /ready가 503이고 남은 작업에 sessions·settings가 있다', async () => {
  const r = await fetch(`http://127.0.0.1:${managementPort}/ready`);
  expect(r.status).toBe(503);
  const body = (await r.json()) as { pending?: string[] };
  expect(body.pending ?? []).toEqual(expect.arrayContaining(['sessions', 'settings']));
}, 60_000);
