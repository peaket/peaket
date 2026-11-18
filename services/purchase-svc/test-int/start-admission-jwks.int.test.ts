// 시작 파일 start()의 입장 토큰 공개키 묶음 주기 읽기(Q-T69 ③④, docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기', ADR-0288 결정 7,
// BUILD_ORDER HOT-400·PRF-137 묶음 BAT-057 계획 §6 T1, 복구 경로 장애 주입). 시험 조립이 아니라 start()를 PEAKET_ADMISSION_JWKS_URL(이 시험이 띄운 대역 HTTP 서버)과
// 실제 Valkey로 띄운다. 차례:
//   ① 대역이 500만 주는 동안(한 번도 받지 못함) 스냅샷 첫 사용은 503 dependency-unavailable·Retry-After: 1이고 구매 세션 표지 s:jti:{jti}가 생기지 않는다
//   ② 대역이 정상 묶음을 주면(받기 전에는 1초마다 다시 읽는다) 같은 입장 토큰의 첫 사용이 구매 세션을 연다(표지·세션 상태가 생긴다). 홀드를 잡는다
//   ③ 대역을 멈춘다(연결 거절). 모르는 kid의 첫 사용이 다시 읽기를 일으켜 실패하고(실패 수 지표가 오른다) 그 요청은 401이다
//   ④ 그 뒤에도 마지막 묶음으로 확인이 이어진다: 홀드 다시 읽기(서명 확인) 200, 열린 구매 세션의 새 홀드 201, 같은 입장 토큰의 스냅샷 재요청 200
// 정본 값(503 이름·Retry-After 1초·지표 이름·키 이름 s:jti:{jti}·s:session:{jti})은 그대로 적는다.
import { createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createHotRedis, type HotRedis, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, purchaseRequestKey } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisSeatStore } from '../src/modules/inventory/index.js';
import { start, type StartedService } from '../src/start.js';
import { claimsOf, newKey, signAdmission } from '../test/admission-fixtures.js';
import { clientKeyOf } from '../test/session-fixtures.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const ISSUER = 'https://queue.peaket.example';
const DAY = 24 * 3600_000;
const EVENT = `it-jwks-${Date.now().toString(36)}`;
const ADMISSION = newKey('it-adm-1');
const STRANGER = newKey('it-adm-unknown');

let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService;
let seatDir: string;
let appPort = 0;
let managementPort = 0;

/** 대역 묶음 서버(queue-svc GET /internal/jwks/admission.json 자리): 받은 요청과 답을 적는다 */
const standIn = { mode: 'fail' as 'fail' | 'ok', served: [] as { at: number; status: number; path: string }[], server: undefined as Server | undefined, port: 0 };
function answer(req: IncomingMessage, res: ServerResponse) {
  const status = standIn.mode === 'ok' ? 200 : 500;
  standIn.served.push({ at: Date.now(), status, path: req.url ?? '' });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(status === 200 ? JSON.stringify({ keys: [{ ...ADMISSION.publicJwk, alg: 'ES256', use: 'sig' }] }) : '{"type":"about:blank"}');
}

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
  return { jwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'it-ecdh-1' }, pub: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! }, format: 'jwk' }) };
})();

/** 회차 좌석맵 판(좌석 A01·A02·A03, 판매 끝은 내일. A03은 첫 홀드 계정 몫) */
const layoutFile = () => ({
  perAccountLimit: 2,
  saleEndsAt: new Date(Date.now() + DAY).toISOString(),
  layout: {
    layoutVersion: 7,
    canvas: { width: 1000, height: 800 },
    sections: [
      {
        sectionId: 'SEC-A',
        name: 'A구역',
        shape: { type: 'polygon', points: [] },
        tierId: 'R',
        seatIndexRange: { from: 0, to: 2 },
        seats: [
          { seatId: 'A01', row: 'A', number: 1, x: 10, y: 20, index: 0 },
          { seatId: 'A02', row: 'A', number: 2, x: 20, y: 20, index: 1 },
          { seatId: 'A03', row: 'A', number: 3, x: 30, y: 20, index: 2 },
        ],
      },
    ],
  },
});

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  seatDir = await mkdtemp(join(tmpdir(), 'peaket-bat057-'));
  await writeFile(join(seatDir, `${EVENT}.json`), JSON.stringify(layoutFile()));
  await new RedisSeatStore(redis).openSale({ eventId: EVENT, seatCount: 3, keepUntilMs: Date.now() + 3 * DAY });
  standIn.server = createServer(answer);
  await new Promise<void>((r) => standIn.server!.listen(0, '127.0.0.1', () => r()));
  standIn.port = (standIn.server.address() as AddressInfo).port;
  appPort = await freePort();
  managementPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_SEAT_REDIS_URL: valkey.url,
      PEAKET_ADMISSION_JWKS_URL: `http://127.0.0.1:${standIn.port}/internal/jwks/admission.json`,
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
}, 120_000);

afterAll(async () => {
  await svc?.close();
  standIn.server?.closeAllConnections();
  await new Promise((r) => (standIn.server ? standIn.server.close(() => r(undefined)) : r(undefined)));
  await redis?.close();
  valkey?.stop();
  if (seatDir) await rm(seatDir, { recursive: true, force: true });
});

const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const LOGIN = 'it-login-1';
const identity = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };
/** 첫 홀드(자동 배정 공연처럼 스냅샷 없이 홀드 본문의 clientEphemeralPublicKey로 구매 세션을 여는 요청)의 계정 */
const ACCOUNT2 = '0190f3a1-7c2e-7a00-8000-0000000000a2';
const LOGIN2 = 'it-login-2';
const identity2 = { 'x-user-id': ACCOUNT2, 'x-session-id': LOGIN2, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };
const app = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${appPort}${path}`, init);
const exists = async (k: string) => Number(await redis.command(['EXISTS', k], { key: k, deadlineMs: 5_000 }));
/** 회차 Stream(s:{event:E}:stream)에 그 jti가 든 항목이 있는가(SESSION_STARTED) */
const startedIn = async (jti: string) => {
  const k = `s:{event:${EVENT}}:stream`;
  return JSON.stringify(await redis.command(['XRANGE', k, '-', '+'], { key: k, deadlineMs: 5_000 })).includes(jti);
};
const failures = async (reason: string) => {
  const text = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`purchase_admission_jwks_fetch_failures_total{reason="${reason}"}`));
  return line === undefined ? undefined : Number(line.trim().split(/\s+/).at(-1));
};

test('Q-T69 ③④ R057-2 (복구 경로 장애 주입) start()는 묶음을 받기 전 첫 사용(스냅샷·첫 홀드)을 503으로 닫고, 받은 뒤 구매 세션을 열며, 묶음 서버가 멈춘 뒤에도 마지막 묶음으로 홀드 다시 읽기·새 홀드·스냅샷 재요청이 이어진다', async () => {
  const jti = randomUUID();
  const token = signAdmission(ADMISSION, claimsOf({ nowMs: Date.now(), jti, accountId: ACCOUNT, loginSessionId: LOGIN, eventId: EVENT }));
  const client = clientKeyOf();
  const macKey = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: ecdh.pub }), jti));
  const snapshot = (t: string, key?: string) => app(`/v1/events/${EVENT}/seatmap-snapshot`, { headers: { ...identity, 'x-admission-token': t, ...(key ? { 'x-client-ephemeral-key': key } : {}) } });
  let seq = 0;
  const hold = (seatIds: string[]) => {
    const url = `/v1/events/${EVENT}/holds`;
    const body = JSON.stringify({ seatIds });
    const n = ++seq;
    return app(url, {
      method: 'POST',
      body,
      headers: { ...identity, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-admission-token': token, 'x-purchase-seq': String(n), 'x-purchase-mac': purchaseMac(macKey, purchaseMacInput('POST', url, n, Buffer.from(body, 'utf8'))) },
    });
  };

  // 첫 홀드(R057-2): 새 jti의 입장 토큰과 본문 clientEphemeralPublicKey로 홀드를 부른다(그 요청에서 구매 세션을 연다)
  const firstJti = randomUUID();
  const firstToken = signAdmission(ADMISSION, claimsOf({ nowMs: Date.now(), jti: firstJti, accountId: ACCOUNT2, loginSessionId: LOGIN2, eventId: EVENT }));
  const firstClient = clientKeyOf();
  const firstMac = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: firstClient.privateKey, publicKey: ecdh.pub }), firstJti));
  const firstHold = () => {
    const url = `/v1/events/${EVENT}/holds`;
    const body = JSON.stringify({ seatIds: ['A03'], clientEphemeralPublicKey: firstClient.text });
    return app(url, {
      method: 'POST',
      body,
      headers: { ...identity2, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-admission-token': firstToken, 'x-purchase-seq': '1', 'x-purchase-mac': purchaseMac(firstMac, purchaseMacInput('POST', url, 1, Buffer.from(body, 'utf8'))) },
    });
  };

  // ① 한 번도 받지 못함: 503 dependency-unavailable, Retry-After 1, 표지 없음
  const until = Date.now() + 5_000;
  while (standIn.served.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  expect(standIn.served.length, '대역 묶음 서버가 요청을 받지 못했다(시작 때 바로 읽지 않았다)').toBeGreaterThanOrEqual(1);
  expect(standIn.served[0]!.path).toBe('/internal/jwks/admission.json');
  const closed = await snapshot(token, client.text);
  expect(closed.status).toBe(503);
  expect(closed.headers.get('retry-after')).toBe('1');
  expect(((await closed.json()) as { type: string }).type).toBe(`${PROBLEM_TYPE_BASE}dependency-unavailable`);
  expect(await exists(`s:jti:{${jti}}`), '503인데 구매 세션 표지를 썼다').toBe(0);
  expect(await exists(`s:session:{${jti}}`)).toBe(0);
  // 첫 홀드도 503 dependency-unavailable·Retry-After 1이고(401로 답하지 않는다) 구매 세션을 열지 않는다(R057-2, seat-hold §2 '한 번도 받지 못했을 때')
  const firstClosed = await firstHold();
  expect(firstClosed.status, `첫 홀드 ${await firstClosed.clone().text()}`).toBe(503);
  expect(firstClosed.headers.get('retry-after')).toBe('1');
  expect(((await firstClosed.json()) as { type: string }).type).toBe(`${PROBLEM_TYPE_BASE}dependency-unavailable`);
  expect(await exists(`s:jti:{${firstJti}}`), '첫 홀드 503인데 구매 세션 표지를 썼다').toBe(0);
  expect(await exists(`s:session:{${firstJti}}`)).toBe(0);
  expect(await startedIn(firstJti), '첫 홀드 503인데 SESSION_STARTED가 있다').toBe(false);
  expect(standIn.served.every((s) => s.status === 500), '실패만 냈다').toBe(true);

  // ② 정상 묶음: 받기 전에는 1초마다 다시 읽으므로 곧 받는다. 같은 토큰의 첫 사용이 세션을 연다
  standIn.mode = 'ok';
  const okBy = Date.now() + 5_000;
  while (!standIn.served.some((s) => s.status === 200) && Date.now() < okBy) await new Promise((r) => setTimeout(r, 50));
  expect(standIn.served.some((s) => s.status === 200), '5초 안에 다시 읽지 않았다').toBe(true);
  let opened = await snapshot(token, client.text);
  // 받은 응답을 읽개가 묶음으로 바꾸기까지의 짧은 틈(503)이면 한 번 더 본다
  for (let i = 0; i < 20 && opened.status === 503; i++) {
    await new Promise((r) => setTimeout(r, 100));
    opened = await snapshot(token, client.text);
  }
  expect(opened.status).toBe(200);
  expect(await exists(`s:jti:{${jti}}`)).toBe(1);
  expect(await exists(`s:session:{${jti}}`)).toBe(1);
  const h1 = await hold(['A01']);
  expect(h1.status).toBe(201);
  const holdId = ((await h1.json()) as { holdId: string }).holdId;
  // 묶음을 받은 뒤 같은 입장 토큰의 첫 홀드는 구매 세션을 열고 홀드를 잡는다(R057-2)
  const firstOpened = await firstHold();
  expect(firstOpened.status, `받은 뒤 첫 홀드 ${await firstOpened.clone().text()}`).toBe(201);
  expect(await exists(`s:jti:{${firstJti}}`)).toBe(1);

  // ③ 묶음 서버를 멈춘다(연결 거절). 모르는 kid의 첫 사용이 다시 읽기를 일으키고 실패한다 → 그 요청은 401, 실패 수 지표가 오른다
  const errorsBefore = (await failures('error')) ?? 0;
  standIn.server!.closeAllConnections();
  await new Promise((r) => standIn.server!.close(() => r(undefined)));
  const strangerJti = randomUUID();
  const strangerToken = signAdmission(STRANGER, claimsOf({ nowMs: Date.now(), jti: strangerJti, accountId: ACCOUNT, loginSessionId: LOGIN, eventId: EVENT }));
  const unknown = await snapshot(strangerToken, clientKeyOf().text);
  expect(unknown.status).toBe(401);
  expect(await exists(`s:jti:{${strangerJti}}`)).toBe(0);
  const errorsAfter = (await failures('error')) ?? 0;
  expect(errorsAfter, '모르는 kid의 다시 읽기가 실패로 세지지 않았다(끊긴 사례가 없었다)').toBeGreaterThan(errorsBefore);

  // ④ 마지막 묶음으로 이어진다
  const reread = await app(`/v1/holds/${holdId}`, { headers: { ...identity, 'x-admission-token': token } });
  expect(reread.status, `홀드 다시 읽기 ${await reread.clone().text()}`).toBe(200);
  expect(((await reread.json()) as { seatIds: string[] }).seatIds).toEqual(['A01']);
  const h2 = await hold(['A02']);
  expect(h2.status).toBe(201);
  const replay = await snapshot(token);
  expect(replay.status).toBe(200);
});
