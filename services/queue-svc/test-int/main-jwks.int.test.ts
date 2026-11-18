// 시작 파일(src/main.ts)을 실제로 띄워 입장 토큰 공개키 묶음 GET /internal/jwks/admission.json을 앱 포트로 읽는다(Q-T69 ①, docs/features/queue-admission.md §6
// '입장 토큰 공개키 묶음과 게이트웨이 확인'의 '키 설정'·'묶음 배포', ADR-0288 결정 1·2, BUILD_ORDER HOT-400 묶음 BAT-057 계획 §6 T2).
// 설정은 환경 값(지금 키 개인 JWK·옛 키 공개 JWK와 끝 시각·다음 키 공개 JWK)이고, 시험 조립이 아닌 시작 파일의 조립을 본다. Kafka 브로커 없는 ci, 실제 Valkey.
// 값(경로·max-age=300·원소 칸)은 정본에서 그대로 적는다.
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let appPort = 0;

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

const key = (kid: string) => {
  const priv: Record<string, string> = { ...(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, string>), kid };
  const { d: _d, ...pub } = priv as Record<string, string>;
  return { priv, pub };
};
const K1 = key('it-prev');
const K2 = key('it-current');
const K3 = key('it-next');
/** 옛 키 끝 시각: 지금 + 2시간(밀리초 0, 상한 지금 + 45분 + 1일 + 1시간 안) */
const UNTIL_MS = (Math.floor(Date.now() / 1000) + 2 * 3600) * 1000;

beforeAll(async () => {
  valkey = await startValkey();
  appPort = await freePort();
  delete process.env.PEAKET_KAFKA_BROKERS;
  delete process.env.PEAKET_CASE_REQUESTS_STUB;
  Object.assign(process.env, {
    PEAKET_ENV: 'ci',
    PEAKET_QUEUE_REDIS_URL: valkey.url,
    PEAKET_QUEUE_TOKEN_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
    PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(K2.priv),
    PEAKET_ADMISSION_TOKEN_ISSUER: 'https://queue.peaket.example',
    PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS: JSON.stringify(K1.pub),
    PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL: new Date(UNTIL_MS).toISOString(),
    PEAKET_ADMISSION_TOKEN_KEY_NEXT: JSON.stringify(K3.pub),
    PEAKET_GRPC_PORT: String(await freePort()),
    PEAKET_GRPC_HOST: '127.0.0.1',
    PORT: String(appPort),
    PEAKET_MANAGEMENT_PORT: String(await freePort()),
    PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
    PEAKET_LOG_LEVEL: 'fatal',
  });
  await import('../src/main.js');
}, 120_000);

afterAll(() => {
  valkey?.stop();
});

test('Q-T69 ① [ASVS v5.0.0-9.1.3] queue-svc 시작 파일이 앱 포트 /internal/jwks/admission.json으로 설정한 지금·다음·옛 키의 공개 부분을 max-age=300으로 준다(옛 키에만 peaket_until, d 없음)', async () => {
  const r = await fetch(`http://127.0.0.1:${appPort}/internal/jwks/admission.json`);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('max-age=300');
  expect(r.headers.get('content-type') ?? '').toMatch(/^application\/json\b/);
  const text = await r.text();
  expect(text).not.toContain('"d"');
  const body = JSON.parse(text) as { keys: Record<string, unknown>[] };
  expect(body.keys.map((k) => k.kid).sort()).toEqual(['it-current', 'it-next', 'it-prev']);
  for (const [k, own] of [
    ['it-current', K2],
    ['it-next', K3],
    ['it-prev', K1],
  ] as const) {
    const e = body.keys.find((x) => x.kid === k)!;
    expect(e, k).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', x: own.pub.x, y: own.pub.y });
    expect(e.peaket_until, k).toBe(k === 'it-prev' ? UNTIL_MS / 1000 : undefined);
  }
});

test('Q-T69 ① queue-svc 시작 파일의 다른 묶음 이름은 404다(공개키 묶음이 나가지 않는다)', async () => {
  for (const name of ['fan.json', 'admin.json', 'ADMISSION.json']) {
    const r = await fetch(`http://127.0.0.1:${appPort}/internal/jwks/${name}`);
    expect(r.status, name).toBe(404);
    expect(await r.text(), name).not.toContain('it-current');
  }
});
