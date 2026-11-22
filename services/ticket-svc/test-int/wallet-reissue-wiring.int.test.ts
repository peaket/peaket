// 월렛 재발급 실제 서버 연결 시험(BUILD_ORDER GAT-020, F-05-1 계획 §8, docs/architecture.md §8.6 4의 4, docs/features/offline-gate.md §11 O-T6·O-T47·O-T48·O-T49).
// 가짜 API로 끝내지 않는다: 웹의 화면 흐름 모듈(apps/web wallet-device-key의 enrollment·reauth-return·register)을 동적으로 가져와
// 로컬 게이트웨이 대역(apps/web/scripts/local-fan-gateway.mjs, ticketUrl) → 실제 ticket-svc HTTP 앱(시작 파일과 같은 조립 assembleDeviceKeys,
// 실제 DrizzleDeviceKeyStore·JwksFanReauthGate) → 실제 PostgreSQL 18(0012까지)·실제 Valkey(재인증 jti 한 번 쓰기)로 잇는다.
// - 실제가 아닌 것: 팬 공개키 묶음 서버(시험이 띄운 HTTP 서버, 시험 키로 재인증 토큰을 서명), core-svc 알림 내부 입구(시험이 띄운 대역.
//   받은 본문을 core-svc의 본문 Zod(TicketKeyNoticeBody)로 검사하는 짝 맞춘 대역), 브라우저 저장소(fake-indexeddb, 메모리 탭 저장소), 재인증 양식 보내기.
// - 컨테이너는 이 파일이 띄우고 끝나면 지운다(test-int/postgres.ts·valkey.ts는 docker rm -f -v).
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { createDatabase, createHotRedis, createService, fakeClock, MemoryDpopReplayStore, RedisReauthJtiStore, type AdminAuthzPort, type Database, type HotRedis, type ScannerSessionCheck } from '@peaket/platform';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TicketKeyNoticeBody } from '../../core-svc/src/modules/notify/inbound/internal-notify-ticket.controller.js';
import { migrateTicket } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { JwksFanReauthGate } from '../src/modules/ticket/adapters/jwks-fan-reauth-gate.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import type { DeviceKeyNoticeSender } from '../src/modules/ticket/application/device-key-notices.js';
import { assembleDeviceKeys } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const web = (p: string) => new URL(`../../../apps/web/${p}`, import.meta.url).href;

const ISS = 'https://identity.f051-wiring.test';
const WEB_ORIGIN = 'http://localhost:3000';
const EVENT = '0193f2c0-0000-7000-8000-0000000e0051';
const ACCOUNT = '0193f2c0-0000-7000-8000-0000000e0052';
const SESSION = '0193f2c0-0000-7000-8000-0000000e0053';
const INTERNAL_TOKEN = 'f051-wiring-internal';
const HOUR = 60 * 60_000;
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class FakeAdmin implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: false, role: '' };
  }
}
class FakeSessions implements ScannerSessionCheck {
  async check(): Promise<{ valid: boolean }> {
    return { valid: false };
  }
}

/** 공개키 JWK(웹 모듈이 내보낸 꼴 그대로 넘긴다) */
type Jwk = Record<string, unknown>;

// 화면 흐름 모듈의 바깥 모양(apps/web/src/features/wallet-device-key의 공개 함수만 쓴다)
interface WalletStatus {
  phase: string;
  key?: { keyId: string; registration: string };
}
interface WebFlow {
  enrollDeviceKey(ticketId: string, o: { origin: string; fetch: typeof fetch }): Promise<WalletStatus>;
  leaveForWalletReauth(i: { ticketId: string; reason: 'REISSUE' | 'ISSUE' }, d: { store: TabStore; now: () => number; provider: string; submit: (p: string, r: string, u: string) => void }): void;
  resumeWalletReauth(ticketId: string, d: { store: TabStore; now: () => number; pickup: () => Promise<{ kind: 'token'; token: string }>; origin: string; fetch: typeof fetch }): Promise<{ kind: string; status: WalletStatus }>;
  registerDeviceKey(i: { ticketId: string; publicKeyJwk: Jwk; keyId: string; reason: 'REISSUE' | 'ISSUE'; reauthToken?: string; origin: string; fetch: typeof fetch }): Promise<{ kind: string }>;
  walletScreenStateOf(r: { kind: string }): string;
  loadDeviceKey(ticketId: string): Promise<{ keyId: string; registration: string; publicKeyJwk: Jwk } | undefined>;
  generateDeviceKey(): Promise<{ publicKeyJwk: Jwk; keyIdText: string }>;
}
interface TabStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let redis: HotRedis;
let svc: Awaited<ReturnType<typeof createService>>;
let jwksServer: Server;
let coreServer: Server;
let gateway: { url: string; close(): Promise<void> };
let notices: DeviceKeyNoticeSender;
let flow: WebFlow;
let tickets: TicketService;
let store: DrizzleDeviceKeyStore;
let accessCookie: string;
const clock = fakeClock({ now: Date.parse('2026-11-23T08:00:00.000Z') });
const coreCalls: { headers: IncomingMessage['headers']; body: unknown; parsed: boolean }[] = [];

// 팬 재인증 토큰 서명 키(시험 키)
const fanKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const fanJwk = fanKey.publicKey.export({ format: 'jwk' }) as Record<string, string>;
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
function reauthToken(): string {
  const nowS = Math.floor(clock.now() / 1000);
  const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid: 'fan-wiring' });
  const body = b64({ iss: ISS, sub: ACCOUNT, aud: 'fan', iat: nowS, exp: nowS + 180, sid: SESSION, jti: randomUUID(), act: 'FAN_SENSITIVE', op: 'DEVICE_KEY_ISSUE' });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: fanKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** 팬 쿠키를 실은 브라우저 fetch(같은 사이트 출처에서 보낸 것처럼 Origin을 싣는다) */
const fanFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cookie', `__Secure-peaket_at=${accessCookie}`);
  headers.set('origin', WEB_ORIGIN);
  const { cache: _c, credentials: _cr, ...rest } = init;
  return fetch(input, { ...rest, headers });
};

const listen = (s: Server) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const tab = (): TabStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
let seq = 0;
async function ticket(startsAtMs: number): Promise<string> {
  seq += 1;
  const r = await tickets.issue({
    orderId: `0193f2c0-0000-7000-8011-${String(seq).padStart(12, '0')}`,
    eventId: EVENT,
    payerAccountId: ACCOUNT,
    seatIds: [`0193f2c0-0000-7000-8012-${String(seq).padStart(12, '0')}`],
    issueGeneration: 0,
    eventStartsAtMs: startsAtMs,
  });
  return r.tickets[0]!.ticketId;
}
async function dbCounts(ticketId: string) {
  const q = async (sql: string) => ((await database.pool.query(sql, [ticketId])).rows[0] as { n: number }).n;
  return {
    keys: await q('select count(*)::int as n from device_key where ticket_id = $1'),
    revoked: await q('select count(*)::int as n from device_key where ticket_id = $1 and revoked_at is not null'),
    notices: await q('select count(*)::int as n from device_key_notice where ticket_id = $1'),
    unsent: await q('select count(*)::int as n from device_key_notice where ticket_id = $1 and sent_at is null'),
  };
}
const activeKeyIds = async (ticketId: string) => ((await store.activeKeysByEvent(EVENT)).get(ticketId) ?? []).map((k) => k.keyId);

beforeAll(async () => {
  [pg, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-wallet-wiring-int', max: 8 });
  redis = await createHotRedis({ url: valkey.url });

  // 팬 공개키 묶음 서버(재인증 토큰 확인용)
  jwksServer = createServer((req, res) => {
    if (req.url !== '/internal/jwks/fan.json') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: fanJwk.x, y: fanJwk.y, kid: 'fan-wiring', alg: 'ES256', use: 'sig' }] }));
  });
  const jwksUrl = `${await listen(jwksServer)}/internal/jwks/fan.json`;

  // core-svc 알림 내부 입구 대역: core-svc의 본문 Zod로 받은 본문을 검사하고 202
  coreServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parsed = req.url === '/internal/v1/notify/ticket-events' && req.method === 'POST' && TicketKeyNoticeBody.safeParse(body).success;
      coreCalls.push({ headers: req.headers, body, parsed });
      res.writeHead(parsed ? 202 : 422, { 'content-type': 'application/json' }).end(JSON.stringify({ created: 1, duplicate: 0 }));
    });
  });
  const coreUrl = await listen(coreServer);

  const gate = new DrizzleScannerGateStore(database);
  store = new DrizzleDeviceKeyStore({ database, changes: gate });
  tickets = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate, deviceKeys: store }), clock });
  const reauth = new JwksFanReauthGate({ jwksUrl, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock });
  const assembled = assembleDeviceKeys({ store, reauth, clock, coreHttpUrl: coreUrl, internalToken: INTERNAL_TOKEN });
  notices = assembled.notices!;
  const replay = new MemoryDpopReplayStore(clock);
  const memGate = new MemoryScannerGateStore();
  const devices = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc-wallet-wiring',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate: memGate, shift: new MemoryScannerShiftStore(memGate) },
      ticket: { deviceKeys: assembled.deviceKeys },
    }),
    env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
  const { port } = await svc.listen('127.0.0.1');

  // 팬 액세스 토큰(게이트웨이 대역이 검증해 신원 머리를 싣는다)
  const access = await generateKeyPair('ES256', { extractable: true });
  const accessJwk = { ...(await exportJWK(access.publicKey)), kid: 'at-wiring', alg: 'ES256', use: 'sig' };
  accessCookie = await new SignJWT({ sid: SESSION, scope: 'openid' })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'at-wiring' })
    .setIssuer(ISS)
    .setAudience('fan')
    .setSubject(ACCOUNT)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(access.privateKey);
  const { startLocalFanGateway } = (await import(/* @vite-ignore */ web('scripts/local-fan-gateway.mjs'))) as {
    startLocalFanGateway(o: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }>;
  };
  gateway = await startLocalFanGateway({ port: 0, identityUrl: 'http://127.0.0.1:9', webOrigin: WEB_ORIGIN, jwks: { keys: [accessJwk] }, issuer: ISS, env: { PEAKET_ENV: 'ci' }, ticketUrl: `http://127.0.0.1:${port}` });

  // 화면 흐름 모듈(브라우저 IndexedDB는 fake-indexeddb)
  await import(/* @vite-ignore */ web('node_modules/fake-indexeddb/auto/index.mjs'));
  const enrollment = await import(/* @vite-ignore */ web('src/features/wallet-device-key/enrollment.ts'));
  const back = await import(/* @vite-ignore */ web('src/features/wallet-device-key/reauth-return.ts'));
  const register = await import(/* @vite-ignore */ web('src/features/wallet-device-key/register.ts'));
  const storeMod = await import(/* @vite-ignore */ web('src/features/wallet-device-key/store.ts'));
  const deviceKey = await import(/* @vite-ignore */ web('src/features/wallet-device-key/device-key.ts'));
  // type-escape: 웹 모듈은 /* @vite-ignore */ 동적 가져오기라 타입이 없다. 쓰는 함수의 바깥 모양만 WebFlow로 적었다(F-05-1 계획 §5)
  flow = { ...enrollment, ...back, ...register, ...storeMod, ...deviceKey } as unknown as WebFlow;
}, 240_000);

afterAll(async () => {
  await gateway?.close().catch(() => {});
  await svc?.close().catch(() => {});
  await new Promise((r) => jwksServer?.close(r));
  await new Promise((r) => coreServer?.close(r));
  await redis?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
  valkey?.stop();
});

describe('월렛 재발급 연결 [GAT-020]', () => {
  test('O-T49 연결 화면 흐름 모듈로 실제 ticket-svc에 재발급하면 옛 키가 폐기되고 알림 행이 하나 생긴다', async () => {
    const opts = { origin: gateway.url, fetch: fanFetch };
    const t = await ticket(clock.now() + 72 * HOUR);
    // 기기 A: 첫 등록(같은 화면 흐름 모듈, 다른 '기기' 저장소를 흉내 내려고 등록 함수를 직접 부른다)
    const deviceA = await flow.generateDeviceKey();
    expect(await flow.registerDeviceKey({ ticketId: t, publicKeyJwk: deviceA.publicKeyJwk, keyId: deviceA.keyIdText, reason: 'ISSUE', ...opts })).toEqual({ kind: 'registered', keyId: deviceA.keyIdText });
    expect(await activeKeyIds(t)).toEqual([deviceA.keyIdText]);

    // 기기 B(이 '브라우저'): 등록을 누르면 403 reissue-required → 저장소 유실, 입장 시작 전
    const st = await flow.enrollDeviceKey(t, opts);
    expect(st.phase).toBe('reissue-required');
    expect(flow.walletScreenStateOf({ kind: 'reissue-required' })).toBe('저장소 유실, 입장 시작 전');
    const local = await flow.loadDeviceKey(t);
    expect(local?.registration).toBe('LOCAL');
    expect(await activeKeyIds(t)).toEqual([deviceA.keyIdText]);
    expect(await dbCounts(t)).toEqual({ keys: 1, revoked: 0, notices: 0, unsent: 0 });

    // [ 다시 로그인하고 받기 ] → 재인증 → 돌아와 같은 공개키로 REISSUE + X-Reauth-Token
    const tabStore = tab();
    const submitted: string[] = [];
    flow.leaveForWalletReauth({ ticketId: t, reason: 'REISSUE' }, { store: tabStore, now: () => clock.now(), provider: 'kakao', submit: (p, r, u) => submitted.push(`${p} ${r} ${u}`) });
    expect(submitted).toEqual([`kakao /my/tickets/${t} device-key-issue`]);
    clock.advance(90_000);
    const back = await flow.resumeWalletReauth(t, { store: tabStore, now: () => clock.now(), pickup: async () => ({ kind: 'token', token: reauthToken() }), ...opts });
    expect(back.kind).toBe('sent');
    expect(back.status.phase).toBe('ready');
    expect(await activeKeyIds(t)).toEqual([local!.keyId]);
    expect(await store.keyState(t, Buffer.from(deviceA.keyIdText, 'base64url'))).toBe('REVOKED');
    expect((await store.revokedKeyIdsByEvent(EVENT)).includes(deviceA.keyIdText)).toBe(true);
    expect(await dbCounts(t)).toEqual({ keys: 2, revoked: 1, notices: 1, unsent: 1 });

    // 보내기 반복이 core 내부 입구 대역으로 한 번 보낸다(본문은 core-svc 본문 Zod를 지난다)
    const before = coreCalls.length;
    expect(await notices.runOnce()).toMatchObject({ attempted: 1, sent: 1 });
    const sent = coreCalls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.parsed).toBe(true);
    expect(sent[0]!.headers['x-peaket-internal-token']).toBe(INTERNAL_TOKEN);
    expect(sent[0]!.body).toMatchObject({ type: 'DEVICE_KEY_REISSUED', accountId: ACCOUNT, ticketId: t });
    expect(await dbCounts(t)).toMatchObject({ notices: 1, unsent: 0 });

    // 23시간 뒤 다시(다른 키·새 토큰): 429 → 재발급 한도
    clock.advance(23 * HOUR);
    const deviceC = await flow.generateDeviceKey();
    const limited = await flow.registerDeviceKey({ ticketId: t, publicKeyJwk: deviceC.publicKeyJwk, keyId: deviceC.keyIdText, reason: 'REISSUE', reauthToken: reauthToken(), ...opts });
    expect(limited).toEqual({ kind: 'reissue-limit' });
    expect(flow.walletScreenStateOf(limited)).toBe('재발급 한도');
    expect(await activeKeyIds(t)).toEqual([local!.keyId]);

    // 같은 재인증 토큰은 한 번만(실제 Valkey jti)
    const once = reauthToken();
    const t2 = await ticket(clock.now() + 72 * HOUR);
    const a2 = await flow.generateDeviceKey();
    await flow.registerDeviceKey({ ticketId: t2, publicKeyJwk: a2.publicKeyJwk, keyId: a2.keyIdText, reason: 'ISSUE', ...opts });
    const b2 = await flow.generateDeviceKey();
    expect(await flow.registerDeviceKey({ ticketId: t2, publicKeyJwk: b2.publicKeyJwk, keyId: b2.keyIdText, reason: 'REISSUE', reauthToken: once, ...opts })).toEqual({ kind: 'registered', keyId: b2.keyIdText });
    const t3 = await ticket(clock.now() + 72 * HOUR);
    const a3 = await flow.generateDeviceKey();
    await flow.registerDeviceKey({ ticketId: t3, publicKeyJwk: a3.publicKeyJwk, keyId: a3.keyIdText, reason: 'ISSUE', ...opts });
    const b3 = await flow.generateDeviceKey();
    expect(await flow.registerDeviceKey({ ticketId: t3, publicKeyJwk: b3.publicKeyJwk, keyId: b3.keyIdText, reason: 'REISSUE', reauthToken: once, ...opts })).toEqual({ kind: 'reissue-required', withToken: true });
    expect(await activeKeyIds(t3)).toEqual([a3.keyIdText]);
  });

  test('O-T6 입장 시작 전 재인증 뒤 재발급되고 옛 키가 폐기 목록에 오르며 24시간 안 두 번째는 429, 입장 시작 뒤는 reissue-at-booth다', async () => {
    const opts = { origin: gateway.url, fetch: fanFetch };
    // 입장 시작 뒤 티켓: 시작 전에 기기 A가 등록해 둔 뒤 회차 시작을 지난 시각으로 옮긴다
    const t = await ticket(clock.now() + 72 * HOUR);
    const deviceA = await flow.generateDeviceKey();
    await flow.registerDeviceKey({ ticketId: t, publicKeyJwk: deviceA.publicKeyJwk, keyId: deviceA.keyIdText, reason: 'ISSUE', ...opts });
    await database.pool.query('update ticket set event_starts_at = $1 where id = $2', [new Date(clock.now() - 60_000), t]);
    const before = await dbCounts(t);
    const st = await flow.enrollDeviceKey(t, opts);
    expect(st).toEqual({ phase: 'reissue-at-booth' });
    expect(flow.walletScreenStateOf({ kind: 'reissue-at-booth' })).toBe('저장소 유실, 입장 시작 뒤');
    expect(await flow.loadDeviceKey(t)).toBeUndefined();
    // 맞는 재인증 토큰이 있어도 같다
    const deviceB = await flow.generateDeviceKey();
    expect(await flow.registerDeviceKey({ ticketId: t, publicKeyJwk: deviceB.publicKeyJwk, keyId: deviceB.keyIdText, reason: 'REISSUE', reauthToken: reauthToken(), ...opts })).toEqual({ kind: 'reissue-at-booth' });
    expect(await activeKeyIds(t)).toEqual([deviceA.keyIdText]);
    expect(await dbCounts(t)).toEqual(before);

    // 입장 시작 전 티켓: 재인증 뒤 재발급되고 옛 키가 폐기 목록에 오르며, 24시간 안 두 번째는 429
    const u = await ticket(clock.now() + 72 * HOUR);
    const a = await flow.generateDeviceKey();
    await flow.registerDeviceKey({ ticketId: u, publicKeyJwk: a.publicKeyJwk, keyId: a.keyIdText, reason: 'ISSUE', ...opts });
    const b = await flow.generateDeviceKey();
    expect(await flow.registerDeviceKey({ ticketId: u, publicKeyJwk: b.publicKeyJwk, keyId: b.keyIdText, reason: 'REISSUE', reauthToken: reauthToken(), ...opts })).toEqual({ kind: 'registered', keyId: b.keyIdText });
    expect((await store.revokedKeyIdsByEvent(EVENT)).includes(a.keyIdText)).toBe(true);
    clock.advance(HOUR);
    const c = await flow.generateDeviceKey();
    expect(await flow.registerDeviceKey({ ticketId: u, publicKeyJwk: c.publicKeyJwk, keyId: c.keyIdText, reason: 'REISSUE', reauthToken: reauthToken(), ...opts })).toEqual({ kind: 'reissue-limit' });
    expect(await activeKeyIds(u)).toEqual([b.keyIdText]);
  });
});
