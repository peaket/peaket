// 레지스트리 정지 중에 새로 뜬 purchase-svc가 주문을 받는지 실제 시작 함수(src/start.ts)로 본다(F-04-2 계획 §6 ST-T16 ②, docs/streaming.md ST-T16 ②,
// ADR-0357 결정 4·5, docs/api/avro/README.md §3 '생산자 스키마 ID', ASVS v5.0.0-16.5.2 '의존이 멈춰도 핵심 기능은 이어 간다').
// 시험 조립이 아니라 start()를 PEAKET_SCHEMA_IDS_FILE(이 시험이 쓴 고정 파일)과 닿지 못하는 레지스트리 주소로 띄운다. 레지스트리 자리는
// 연결을 받자마자 끊는 TCP 서버라(연결 오류) 서비스가 실제로 물으러 왔는지 셀 수 있다. 실제 PostgreSQL 18·Valkey 8.1, 입장 토큰 공개키 묶음은 대역 HTTP 서버.
// 정본 값: 시작 확인이 닿지 못하면 설정의 ID로 계속(시작 실패가 아님)·게이지 schema_startup_check_unavailable{subject} 1(결정 5), Outbox 값의 앞 다섯 바이트는
// 매직 바이트 0과 설정 파일의 trade.orders-peaket.trade.OrderEvent ID(README §3). 스키마 ID는 코드 상수와 겹치지 않게 23·29로 고른다.
import { createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createDatabase, createHotRedis, type Database, type HotRedis, purchaseMac, purchaseMacInput, purchaseRequestKey } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { decodeProduced } from '../../../packages/platform/test/produced-avro.js';
import { ensurePurchaseOutboxPartitions, ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { RedisSeatStore } from '../src/modules/inventory/index.js';
import { start, type StartedService } from '../src/start.js';
import { claimsOf, newKey, signAdmission } from '../test/admission-fixtures.js';
import { clientKeyOf } from '../test/session-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const ISSUER = 'https://queue.peaket.example';
const DAY = 24 * 3600_000;
const EVENT = randomUUID();
const ADMISSION = newKey('it-adm-st16');
const CONSENT = 'consent-2026.11_st16';
const ORDER_SUBJECT = 'trade.orders-peaket.trade.OrderEvent';
const BEHAVIOR_SUBJECT = 'telemetry.behavior-peaket.telemetry.BehaviorSignal';
const SCHEMA_IDS = { [ORDER_SUBJECT]: 23, [BEHAVIOR_SUBJECT]: 29 };
const PRICE = 77_000;
/** 좌석 ID(주문 항목은 소문자 UUID여야 한다) */
const SEAT_1 = randomUUID();
const SEAT_2 = randomUUID();

let pgServer: PostgresContainer;
let admin: Database;
let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService | undefined;
let dir: string;
let jwks: Server;
let registry: NetServer;
/** 레지스트리 자리가 받은 연결 수(받자마자 끊는다) */
let registryConnections = 0;
let appPort = 0;
let managementPort = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const ecdh = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { jwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'it-ecdh-st16' }, pub: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! }, format: 'jwk' }) };
})();

/** 회차 좌석맵 판(좌석 둘, 등급 R 가격 PRICE, 판매 끝은 내일) */
const layoutFile = () => ({
  perAccountLimit: 2,
  saleEndsAt: new Date(Date.now() + DAY).toISOString(),
  tierPrices: { R: PRICE },
  layout: {
    layoutVersion: 3,
    canvas: { width: 1000, height: 800 },
    sections: [
      {
        sectionId: 'SEC-A',
        name: 'A구역',
        shape: { type: 'polygon', points: [] },
        tierId: 'R',
        seatIndexRange: { from: 0, to: 1 },
        seats: [
          { seatId: SEAT_1, row: 'A', number: 1, x: 10, y: 20, index: 0 },
          { seatId: SEAT_2, row: 'A', number: 2, x: 20, y: 20, index: 1 },
        ],
      },
    ],
  },
});

beforeAll(async () => {
  pgServer = await startPostgres();
  await migratePurchase(pgServer.url);
  await ensureSeatHoldPartitions(pgServer.url);
  await ensurePurchaseOutboxPartitions(pgServer.url);
  admin = createDatabase({ url: pgServer.url, profile: 'general', max: 2, applicationName: 'st16-admin' });
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  dir = await mkdtemp(join(tmpdir(), 'peaket-st16-'));
  const seatDir = join(dir, 'seatmap');
  await mkdir(seatDir, { recursive: true });
  await writeFile(join(seatDir, `${EVENT}.json`), JSON.stringify(layoutFile()));
  await new RedisSeatStore(redis).openSale({ eventId: EVENT, seatCount: 2, keepUntilMs: Date.now() + 3 * DAY });
  const schemaIdsFile = join(dir, 'schema-ids.json');
  await writeFile(schemaIdsFile, JSON.stringify(SCHEMA_IDS));
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...ADMISSION.publicJwk, alg: 'ES256', use: 'sig' }] }));
  });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', () => r()));
  // 레지스트리 정지: 연결은 받되 바로 끊는다(HTTP 답이 없다)
  registry = createNetServer((sock: Socket) => {
    registryConnections += 1;
    sock.destroy();
  });
  await new Promise<void>((r) => registry.listen(0, '127.0.0.1', () => r()));
  appPort = await freePort();
  managementPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_DATABASE_URL: pgServer.url,
      PEAKET_ORDER_CONSENT_VERSION: CONSENT,
      PEAKET_SCHEMA_IDS_FILE: schemaIdsFile,
      PEAKET_SCHEMA_REGISTRY_URL: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
      PEAKET_SEAT_REDIS_URL: valkey.url,
      PEAKET_ADMISSION_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/internal/jwks/admission.json`,
      PEAKET_ADMISSION_ISSUER: ISSUER,
      PEAKET_SEATMAP_DIR: seatDir,
      PEAKET_PURCHASE_ECDH_KEY: JSON.stringify(ecdh.jwk),
      PORT: String(appPort),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  jwks?.closeAllConnections();
  await Promise.allSettled([new Promise((r) => (jwks ? jwks.close(() => r(undefined)) : r(undefined))), new Promise((r) => (registry ? registry.close(() => r(undefined)) : r(undefined)))]);
  await Promise.allSettled([redis?.close(), admin?.close()]);
  valkey?.stop();
  pgServer?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const ACCOUNT = randomUUID();
const LOGIN = randomUUID();
const identity = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': `pid-${randomUUID()}` };
const app = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${appPort}${path}`, init);
const gaugeOf = (text: string, subject: string): number | undefined => {
  const line = text.split('\n').find((l) => l.startsWith(`schema_startup_check_unavailable{subject="${subject}"}`));
  return line === undefined ? undefined : Number(line.trim().split(/\s+/).at(-1));
};

test('ST-T16 ② [ASVS v5.0.0-16.5.2] 레지스트리가 멈춘 채 시작 파일로 띄운 purchase-svc가 주문을 만든다', async () => {
  // 시작 확인이 레지스트리에 물으러 갔고(연결을 받았다) 닿지 못했다: 시작은 됐고 게이지가 주제마다 1이다
  expect(registryConnections, '시작 확인이 레지스트리에 묻지 않았다').toBeGreaterThanOrEqual(1);
  const atStart = registryConnections;
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(gaugeOf(metrics, ORDER_SUBJECT)).toBe(1);
  expect(gaugeOf(metrics, BEHAVIOR_SUBJECT)).toBe(1);

  // 입장 토큰 → 스냅샷으로 구매 세션 열기 → 홀드 → 주문
  const jti = randomUUID();
  const token = signAdmission(ADMISSION, claimsOf({ nowMs: Date.now(), jti, accountId: ACCOUNT, loginSessionId: LOGIN, eventId: EVENT }));
  const client = clientKeyOf();
  const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: ecdh.pub }), jti));
  let opened = await app(`/v1/events/${EVENT}/seatmap-snapshot`, { headers: { ...identity, 'x-admission-token': token, 'x-client-ephemeral-key': client.text } });
  // 시작 직후 공개키 묶음을 받기 전의 짧은 틈(503)이면 다시 본다(1초마다 다시 읽는다)
  for (let i = 0; i < 50 && opened.status === 503; i++) {
    await new Promise((r) => setTimeout(r, 100));
    opened = await app(`/v1/events/${EVENT}/seatmap-snapshot`, { headers: { ...identity, 'x-admission-token': token, 'x-client-ephemeral-key': client.text } });
  }
  expect(opened.status, await opened.clone().text()).toBe(200);
  let seq = 0;
  const signed = (url: string, body: unknown) => {
    const payload = JSON.stringify(body);
    const n = ++seq;
    return app(url, {
      method: 'POST',
      body: payload,
      headers: { ...identity, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-admission-token': token, 'x-purchase-seq': String(n), 'x-purchase-mac': purchaseMac(macKey, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8'))) },
    });
  };
  const h = await signed(`/v1/events/${EVENT}/holds`, { seatIds: [SEAT_1] });
  expect(h.status, await h.clone().text()).toBe(201);
  const holdId = ((await h.json()) as { holdId: string }).holdId;
  const o = await signed('/v1/orders', { holdId, buyer: { name: '김피켓', phone: '010-1234-5678' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: CONSENT } });
  expect(o.status, await o.clone().text()).toBe(201);
  const orderId = ((await o.json()) as { orderId: string }).orderId;

  // 그 주문의 Outbox 행: 앞 다섯 바이트가 매직 바이트 0과 파일의 주문 사건 ID, 계약 판으로 풀린다
  const rows = (await admin.pool.query<{ topic: string; msg_key: string; payload: Buffer }>('select topic, msg_key, payload from outbox where msg_key = $1', [EVENT])).rows;
  expect(rows).toHaveLength(1);
  expect([rows[0]!.topic, rows[0]!.msg_key]).toEqual(['trade.orders', EVENT]);
  const payload = Buffer.from(rows[0]!.payload);
  expect([...payload.subarray(0, 5)]).toEqual([0, 0, 0, 0, SCHEMA_IDS[ORDER_SUBJECT]]);
  const p = decodeProduced(payload, 'peaket.trade.OrderEvent');
  expect(p.violations).toEqual([]);
  expect(p.value).toMatchObject({ type: 'CREATED', orderId, eventId: EVENT, accountId: ACCOUNT, amount: PRICE, seatIds: [SEAT_1], purchaseSessionId: jti });
  // 홀드·주문을 만드는 동안 레지스트리를 부르지 않았다(실행 중에는 설정의 ID만 쓴다, README §3)
  expect(registryConnections).toBe(atStart);
}, 120_000);
