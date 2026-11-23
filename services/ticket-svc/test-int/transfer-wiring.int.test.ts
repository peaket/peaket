// F-05-2 양도 실제 서버 연결 시험(계획 docs/review/plans/F-05-2.md §7·§5 T18, docs/architecture.md §8.6 4의 4 '가짜 API로 끝내지 않는다').
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 선례: wallet-reissue-wiring.int.test.ts(F-05-1).
// 웹의 화면 흐름 모듈(apps/web: ticket-transfer transfer-flow·transfer-offer offer-flow·ticket-wallet transfer-actions·wallet-device-key register)을
// 동적으로 가져와, 끊는 중계(브라우저와 게이트웨이 사이) → 로컬 게이트웨이 대역(apps/web/scripts/local-fan-gateway.mjs, ticketUrl) →
// 실제 ticket-svc HTTP 앱(시작 파일과 같은 조립: Drizzle 저장소 셋·JwksFanReauthGate·assembleDeviceKeys) → 실제 PostgreSQL 18(0018까지)·실제 Valkey(재인증 jti)로 잇는다.
// - 실제가 아닌 것: 팬 공개키 묶음 서버(시험이 띄운 HTTP 서버, 시험 키로 재인증 토큰 서명), identity 회원 코드 찾기(포트 짝 가짜, gRPC 어댑터는 BAT-410 시험),
//   알림(뒤 몫 F-05-11), 브라우저의 소셜 제공자 왕복, 브라우저 IndexedDB(fake-indexeddb).
// - 정본: docs/features/transfer-refund.md §3.1·§4·§5·§11 R-T1·R-T2·R-T17·R-T25, docs/features/identity.md §7.1(재인증 토큰 클레임), docs/security/authz-matrix.md §6.
// - 돌려준 뒤 결제자의 다시 등록은 정본대로 reason=TRANSFER다(transfer-refund §4 '돌려주기', offline-gate §4. 시험 리뷰 RV-01·감독 결정 2026-11-23).
//   지금 기기 키 저장소가 결제자 그대로면 TRANSFER를 transfer-not-allowed로 거절하면, 이 단언은 구현 결함으로 실패한 채 남는다.
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { createDatabase, createHotRedis, createService, fakeClock, MemoryDpopReplayStore, RedisReauthJtiStore, type AdminAuthzPort, type Database, type HotRedis, type ScannerSessionCheck } from '@peaket/platform';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleTransferStore } from '../src/modules/ticket/adapters/db/drizzle-transfer-store.js';
import { JwksFanReauthGate } from '../src/modules/ticket/adapters/jwks-fan-reauth-gate.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { Transfers } from '../src/modules/ticket/application/transfers.js';
import type { MemberCodeDirectory } from '../src/modules/ticket/domain/transfer-ports.js';
import { assembleDeviceKeys } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const web = (p: string) => new URL(`../../../apps/web/${p}`, import.meta.url).href;

const ISS = 'https://identity.f052-wiring.test';
const WEB_ORIGIN = 'http://localhost:3000';
const EVENT = '0193f2c0-0000-7000-8000-0000000e0521';
const HOUR = 60 * 60_000;
const CODE_B = 'QZ7-4K2M';
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

interface Account {
  readonly id: string;
  readonly sid: string;
  cookie: string;
}
const A: Account = { id: randomUUID(), sid: randomUUID(), cookie: '' };
const B: Account = { id: randomUUID(), sid: randomUUID(), cookie: '' };

/** identity 회원 코드 찾기 포트의 짝 가짜(MemberCodeService.ResolveMemberCodes가 닉네임을 싣지 않아 '회원') */
class Directory implements MemberCodeDirectory {
  async resolveMemberCode(code: string): Promise<{ accountId: string; nickname: string } | undefined> {
    return code === CODE_B ? { accountId: B.id, nickname: '회원' } : undefined;
  }
}

// 화면 흐름 모듈의 바깥 모양(계획 §4 '웹 모듈'과 이 기능의 웹 단위 시험이 쓰는 모양)
type Result<T> = { kind: 'ok'; body: T } | { kind: 'problem'; status: number; type: string } | { kind: 'network' };
type Fetch = typeof fetch;
interface Net {
  origin: string;
  fetch: Fetch;
}
interface TicketBody {
  transferable?: boolean;
  pendingTransfer?: { offerId: string; expiresAt: string } | null;
  receivedFromNickname?: string | null;
}
interface OfferBody {
  offerId: string;
  status: string;
  withdrawReason?: string;
}
interface WebFlow {
  loadTransferTicket(i: { ticketId: string } & Net): Promise<Result<TicketBody>>;
  lookupRecipient(i: { memberCode: string } & Net): Promise<Result<{ recipientRef: string; nicknameMasked: string }>>;
  sendTransferRequest(i: { ticketId: string; recipientRef: string; reauthToken: string; idempotencyKey: string } & Net): Promise<Result<OfferBody>>;
  withdrawTransferRequest(i: { offerId: string; idempotencyKey: string } & Net): Promise<Result<OfferBody>>;
  transferStateOf(t: TicketBody, nowMs: number): string;
  loadOffer(i: { offerId: string } & Net): Promise<Result<OfferBody>>;
  acceptOffer(i: { offerId: string; idempotencyKey: string } & Net): Promise<Result<OfferBody>>;
  offerStateOf(o: OfferBody, nowMs: number): string;
  acceptFailureStateOf(p: { status: number; type: string }): string;
  loadReceivedOffers(i: Net): Promise<Result<{ items: OfferBody[] }>>;
  receivedOfferCardsOf(items: readonly OfferBody[], nowMs: number): { offerId: string; href: string }[];
  returnTicket(i: { ticketId: string; reauthToken: string; idempotencyKey: string } & Net): Promise<Result<{ ticketId: string; status: string }>>;
  registerDeviceKey(i: { ticketId: string; publicKeyJwk: Record<string, unknown>; keyId: string; reason: 'ISSUE' | 'TRANSFER'; origin: string; fetch: Fetch }): Promise<{ kind: string }>;
  generateDeviceKey(): Promise<{ publicKeyJwk: Record<string, unknown>; keyIdText: string; privateKey: unknown }>;
  saveDeviceKey(k: Record<string, unknown>): Promise<void>;
  loadDeviceKey(ticketId: string): Promise<{ keyId: string } | undefined>;
}

let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let redis: HotRedis;
let svc: Awaited<ReturnType<typeof createService>>;
let jwksServer: Server;
let relay: Server;
let gateway: { url: string; close(): Promise<void> };
let flow: WebFlow;
let tickets: TicketService;
let ticketStore: DrizzleTicketStore;
let relayUrl = '';
const clock = fakeClock({ now: Date.parse('2026-11-23T09:00:00.000Z') });

/** 끊는 중계: 다음에 맞는 요청 하나는 게이트웨이 응답을 다 받은 뒤 브라우저 쪽 소켓을 끊는다(커밋 뒤 응답 전 끊김) */
const drop = { next: null as null | RegExp, count: 0 };

// 팬 재인증 토큰 서명 키(시험 키)
const fanKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const fanJwk = fanKey.publicKey.export({ format: 'jwk' }) as Record<string, string>;
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
function reauthToken(who: Account, act: 'FAN_HIGH_RISK' | 'FAN_SENSITIVE', op: 'TRANSFER_REQUEST' | 'TICKET_RETURN'): string {
  const nowS = Math.floor(clock.now() / 1000);
  const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid: 'fan-f052' });
  const body = b64({ iss: ISS, sub: who.id, aud: 'fan', iat: nowS, exp: nowS + 180, sid: who.sid, jti: randomUUID(), act, op, provider: 'kakao', strength: 'verified' });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: fanKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** 그 계정의 팬 쿠키를 실은 브라우저 fetch(같은 사이트 출처의 Origin) */
const fanFetch =
  (who: Account): Fetch =>
  (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', `__Secure-peaket_at=${who.cookie}`);
    headers.set('origin', WEB_ORIGIN);
    const { cache: _c, credentials: _cr, ...rest } = init;
    return fetch(input, { ...rest, headers });
  };
const as = (who: Account): Net => ({ origin: relayUrl, fetch: fanFetch(who) });

const listen = (s: Server) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await database.pool.query(sql, params)).rows as T[];
const ticketRow = async (id: string) => (await q<{ account_id: string; status: string; version: string; transfer_pending: boolean }>('select account_id, status, version, transfer_pending from ticket where id = $1', [id]))[0]!;
const activeKeyOwners = async (id: string) => (await q<{ account_id: string }>('select account_id from device_key where ticket_id = $1 and revoked_at is null', [id])).map((r) => r.account_id);

let seq = 0;
async function ticket(): Promise<string> {
  seq += 1;
  const r = await tickets.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: A.id, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: clock.now() + 72 * HOUR });
  return r.tickets[0]!.ticketId;
}

async function signAccess(who: Account, key: Parameters<SignJWT['sign']>[0]): Promise<string> {
  return new SignJWT({ sid: who.sid, scope: 'openid' })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'at-f052' })
    .setIssuer(ISS)
    .setAudience('fan')
    .setSubject(who.id)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

beforeAll(async () => {
  [pg, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-transfer-wiring-int', max: 8 });
  redis = await createHotRedis({ url: valkey.url });

  jwksServer = createServer((req, res) => {
    if (req.url !== '/internal/jwks/fan.json') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: fanJwk.x, y: fanJwk.y, kid: 'fan-f052', alg: 'ES256', use: 'sig' }] }));
  });
  const jwksUrl = `${await listen(jwksServer)}/internal/jwks/fan.json`;

  // 시작 파일(start.ts)과 같은 조립: Drizzle 저장소 셋, 같은 재인증 확인기를 양도·기기 키가 함께 쓴다
  const gate = new DrizzleScannerGateStore(database);
  const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gate });
  ticketStore = new DrizzleTicketStore({ database, changes: gate, deviceKeys: deviceKeyStore });
  tickets = new TicketService({ store: ticketStore, clock });
  const transferStore = new DrizzleTransferStore({ database, deviceKeys: deviceKeyStore });
  const reauth = new JwksFanReauthGate({ jwksUrl, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock });
  const { deviceKeys } = assembleDeviceKeys({ store: deviceKeyStore, reauth, clock });
  const transfers = new Transfers({ store: transferStore, reauth, recipientRefSecret: 'f052-wiring-secret', clock, directory: new Directory() });
  const replay = new MemoryDpopReplayStore(clock);
  const memGate = new MemoryScannerGateStore();
  const devices = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc-transfer-wiring',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate: memGate, shift: new MemoryScannerShiftStore(memGate) },
      ticket: { deviceKeys, tickets, transfers },
    }),
    env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
  const { port } = await svc.listen('127.0.0.1');

  const access = await generateKeyPair('ES256', { extractable: true });
  const accessJwk = { ...(await exportJWK(access.publicKey)), kid: 'at-f052', alg: 'ES256', use: 'sig' };
  A.cookie = await signAccess(A, access.privateKey);
  B.cookie = await signAccess(B, access.privateKey);
  const { startLocalFanGateway } = (await import(/* @vite-ignore */ web('scripts/local-fan-gateway.mjs'))) as {
    startLocalFanGateway(o: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }>;
  };
  gateway = await startLocalFanGateway({ port: 0, identityUrl: 'http://127.0.0.1:9', webOrigin: WEB_ORIGIN, jwks: { keys: [accessJwk] }, issuer: ISS, env: { PEAKET_ENV: 'ci' }, ticketUrl: `http://127.0.0.1:${port}` });

  // 브라우저 ↔ 게이트웨이 사이 끊는 중계
  const upstream = new URL(gateway.url);
  relay = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const up = httpRequest({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        const body: Buffer[] = [];
        ur.on('data', (c: Buffer) => body.push(c));
        ur.on('end', () => {
          if (drop.next && drop.next.test(`${req.method} ${req.url}`)) {
            drop.next = null;
            drop.count += 1;
            req.socket.destroy();
            return;
          }
          res.writeHead(ur.statusCode ?? 502, ur.headers).end(Buffer.concat(body));
        });
      });
      up.on('error', () => res.writeHead(502).end());
      up.end(Buffer.concat(chunks));
    });
  });
  relayUrl = await listen(relay);

  await import(/* @vite-ignore */ web('node_modules/fake-indexeddb/auto/index.mjs'));
  const transferFlow = await import(/* @vite-ignore */ web('src/_pages/ticket-transfer/model/transfer-flow.ts'));
  const offerFlow = await import(/* @vite-ignore */ web('src/_pages/transfer-offer/model/offer-flow.ts'));
  const actions = await import(/* @vite-ignore */ web('src/widgets/ticket-wallet/model/transfer-actions.ts'));
  const register = await import(/* @vite-ignore */ web('src/features/wallet-device-key/register.ts'));
  const deviceKey = await import(/* @vite-ignore */ web('src/features/wallet-device-key/device-key.ts'));
  const store = await import(/* @vite-ignore */ web('src/entities/wallet/index.ts'));
  // type-escape: 웹 모듈은 /* @vite-ignore */ 동적 가져오기라 타입이 없다. 쓰는 함수의 바깥 모양만 WebFlow로 적었다(계획 §4 '웹 모듈', F-05-2)
  flow = { ...transferFlow, ...offerFlow, ...actions, ...register, ...deviceKey, ...store } as unknown as WebFlow;
}, 240_000);

afterAll(async () => {
  await new Promise((r) => relay?.close(r));
  await gateway?.close().catch(() => {});
  await svc?.close().catch(() => {});
  await new Promise((r) => jwksServer?.close(r));
  await redis?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
  valkey?.stop();
});

/** 이 기기(받는 사람 브라우저)에 키를 만들어 서버에 등록한다 */
async function enroll(who: Account, ticketId: string, reason: 'ISSUE' | 'TRANSFER', o: { keepLocal?: boolean } = {}): Promise<string> {
  const key = await flow.generateDeviceKey();
  const r = await flow.registerDeviceKey({ ticketId, publicKeyJwk: key.publicKeyJwk, keyId: key.keyIdText, reason, ...as(who) });
  expect(r).toEqual({ kind: 'registered', keyId: key.keyIdText });
  if (o.keepLocal) await flow.saveDeviceKey({ ticketId, keyId: key.keyIdText, privateKey: key.privateKey, publicKeyJwk: key.publicKeyJwk, createdAt: clock.now(), reason, registration: 'REGISTERED' });
  return key.keyIdText;
}

describe('F-05-2 T18 양도 실제 서버 연결 [GAT-050·GAT-055]', () => {
  test('F-05-2 T18 R-T1 R-T2 R-T17 ① 요청 → 받은 요청 카드 → 수락(응답 끊김 뒤 같은 키) → 입장용 등록 → 돌려주기(응답 끊김 뒤 같은 키·새 토큰) → 결제자 다시 등록', async () => {
    const t = await ticket();
    await enroll(A, t, 'ISSUE');
    expect(await activeKeyOwners(t)).toEqual([A.id]);

    // A: 상세 → 양도 양식
    const detail = await flow.loadTransferTicket({ ticketId: t, ...as(A) });
    expect(detail.kind).toBe('ok');
    const d = (detail as { body: TicketBody }).body;
    expect(d.transferable).toBe(true);
    expect(flow.transferStateOf(d, clock.now())).toBe('받는 사람 확인');

    // A: 회원 코드 → 재인증 토큰(FAN_HIGH_RISK·TRANSFER_REQUEST) → 요청
    const found = await flow.lookupRecipient({ memberCode: CODE_B, ...as(A) });
    expect(found.kind).toBe('ok');
    const ref = (found as { body: { recipientRef: string } }).body.recipientRef;
    const requestKey = randomUUID();
    const sent = await flow.sendTransferRequest({ ticketId: t, recipientRef: ref, reauthToken: reauthToken(A, 'FAN_HIGH_RISK', 'TRANSFER_REQUEST'), idempotencyKey: requestKey, ...as(A) });
    expect(sent.kind).toBe('ok');
    const offerId = (sent as { body: OfferBody }).body.offerId;
    const pending = await flow.loadTransferTicket({ ticketId: t, ...as(A) });
    expect((pending as { body: TicketBody }).body.pendingTransfer?.offerId).toBe(offerId);
    expect(flow.transferStateOf((pending as { body: TicketBody }).body, clock.now())).toBe('요청 보냄');

    // B: 받은 요청 카드 → SCR-041
    const received = await flow.loadReceivedOffers(as(B));
    expect(received.kind).toBe('ok');
    const cards = flow.receivedOfferCardsOf((received as { body: { items: OfferBody[] } }).body.items, clock.now());
    expect(cards.map((c) => [c.offerId, c.href])).toEqual([[offerId, `/my/transfers/${offerId}`]]);
    const seen = await flow.loadOffer({ offerId, ...as(B) });
    expect(flow.offerStateOf((seen as { body: OfferBody }).body, clock.now())).toBe('요청');

    // B: 받기 — 첫 응답을 잃는다(서버는 커밋했다) → 같은 키로 다시 보내 재생 200
    const acceptKey = randomUUID();
    drop.next = /^POST \/v1\/transfers\/[^/]+\/acceptance$/;
    expect(await flow.acceptOffer({ offerId, idempotencyKey: acceptKey, ...as(B) })).toEqual({ kind: 'network' });
    expect(drop.count).toBe(1);
    const accepted = await flow.acceptOffer({ offerId, idempotencyKey: acceptKey, ...as(B) });
    expect(accepted.kind).toBe('ok');
    expect((accepted as { body: OfferBody }).body.status).toBe('ACCEPTED');
    const afterAccept = await ticketRow(t);
    expect(afterAccept.account_id).toBe(B.id);
    expect(await activeKeyOwners(t)).toEqual([]);

    // B: 이 휴대폰을 입장용으로 등록(TRANSFER)
    const bKey = await enroll(B, t, 'TRANSFER', { keepLocal: true });
    expect(await activeKeyOwners(t)).toEqual([B.id]);
    expect((await flow.loadDeviceKey(t))?.keyId).toBe(bKey);

    // B: 결제자에게 돌려주기 — 첫 응답을 잃는다 → 새 재인증 토큰·같은 키로 다시 보내 재생 200, 보유자 바꿈은 한 번
    const returnKey = randomUUID();
    drop.next = /^POST \/v1\/tickets\/[^/]+\/returns$/;
    expect(await flow.returnTicket({ ticketId: t, reauthToken: reauthToken(B, 'FAN_SENSITIVE', 'TICKET_RETURN'), idempotencyKey: returnKey, ...as(B) })).toEqual({ kind: 'network' });
    expect(drop.count).toBe(2);
    const v1 = Number((await ticketRow(t)).version);
    clock.advance(60_000);
    const returned = await flow.returnTicket({ ticketId: t, reauthToken: reauthToken(B, 'FAN_SENSITIVE', 'TICKET_RETURN'), idempotencyKey: returnKey, ...as(B) });
    expect(returned).toEqual({ kind: 'ok', body: { ticketId: t, status: 'RETURNED' } });
    expect(await ticketRow(t)).toMatchObject({ account_id: A.id });
    expect(Number((await ticketRow(t)).version)).toBe(v1);
    expect(await activeKeyOwners(t)).toEqual([]);
    expect(await flow.loadDeviceKey(t)).toBeUndefined();
    // 돌려준 표는 B의 월렛 목록에서 빠지고 A의 목록에 돌아온다(RV-09)
    const listOf = async (who: Account) => ((await (await fanFetch(who)(`${relayUrl}/v1/tickets`, { method: 'GET' })).json()) as { items: { ticketId: string }[] }).items.map((i) => i.ticketId);
    expect(await listOf(B)).not.toContain(t);
    expect(await listOf(A)).toContain(t);

    // A: 결제자가 '입장용으로 등록'으로 키를 다시 등록한다(reason=TRANSFER, transfer-refund §4·offline-gate §4, RV-01)
    await enroll(A, t, 'TRANSFER');
    expect(await activeKeyOwners(t)).toEqual([A.id]);
  });

  test('F-05-2 T18 R-T1 ② 철회하면 결제자 상세의 pendingTransfer가 null이고 양식이 다시 열린다', async () => {
    const t = await ticket();
    const found = await flow.lookupRecipient({ memberCode: CODE_B, ...as(A) });
    const ref = (found as { body: { recipientRef: string } }).body.recipientRef;
    const sent = await flow.sendTransferRequest({ ticketId: t, recipientRef: ref, reauthToken: reauthToken(A, 'FAN_HIGH_RISK', 'TRANSFER_REQUEST'), idempotencyKey: randomUUID(), ...as(A) });
    const offerId = (sent as { body: OfferBody }).body.offerId;
    const w = await flow.withdrawTransferRequest({ offerId, idempotencyKey: randomUUID(), ...as(A) });
    expect(w.kind).toBe('ok');
    const d = (await flow.loadTransferTicket({ ticketId: t, ...as(A) })) as { body: TicketBody };
    expect(d.body.pendingTransfer).toBeNull();
    expect(flow.transferStateOf(d.body, clock.now())).toBe('받는 사람 확인');
  });

  test('F-05-2 T18 R-T25 ② ③ 회차 취소 뒤 받는 사람의 받기는 409이고 화면은 공연 취소 문장을, 목록은 WITHDRAWN을 보인다', async () => {
    const t = await ticket();
    const found = await flow.lookupRecipient({ memberCode: CODE_B, ...as(A) });
    const ref = (found as { body: { recipientRef: string } }).body.recipientRef;
    const sent = await flow.sendTransferRequest({ ticketId: t, recipientRef: ref, reauthToken: reauthToken(A, 'FAN_HIGH_RISK', 'TRANSFER_REQUEST'), idempotencyKey: randomUUID(), ...as(A) });
    const offerId = (sent as { body: OfferBody }).body.offerId;
    await ticketStore.eventCancel({ cancellationRequestId: randomUUID(), eventId: EVENT, targets: [{ ticketId: t, cancellationId: randomUUID() }], nowMs: clock.now() });
    const r = await flow.acceptOffer({ offerId, idempotencyKey: randomUUID(), ...as(B) });
    expect(r.kind).toBe('problem');
    expect((r as { status: number }).status).toBe(409);
    expect(flow.acceptFailureStateOf(r as { status: number; type: string })).toBe('처리됨');
    const seen = (await flow.loadOffer({ offerId, ...as(B) })) as { body: OfferBody };
    expect(seen.body).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'EVENT_CANCELLED' });
    expect(flow.offerStateOf(seen.body, clock.now())).toBe('공연 취소로 철회됨');
    const all = await fanFetch(B)(`${relayUrl}/v1/transfers`, { method: 'GET' });
    expect(all.status).toBe(200);
    const items = ((await all.json()) as { items: OfferBody[] }).items;
    expect(items.find((i) => i.offerId === offerId)?.status).toBe('WITHDRAWN');
    expect(await ticketRow(t)).toMatchObject({ status: 'REFUNDED', account_id: A.id });
  });
});
