// F-05-4(GAT-140 B5·B7·B8, GAT-160 버전 벡터 동시 스캔) 실제 서버 연결 시험(계획 docs/review/plans/F-05-4.md §6·§7).
// - ticket-svc는 시작 파일 start()로 띄운다(실제 PostgreSQL 18·Valkey, HTTP·관리 포트). identity-svc 자리는 계약(identity.proto ScannerSessionCheckService)
//   모양 gRPC 대역, core-svc 자리는 내부 경로 GET /internal/v1/events/{eventId}/sale-config 대역(http-core-event-policy.ts eventPolicyOf가 받는 모양, 값을 바꿀 수 있다).
// - gw-scanner 자리는 시험이 띄운 중계다: 전달 머리(x-forwarded-*)·스캐너 PWA Origin을 달고, 스태프 토큰이면 게이트웨이가 싣는 신원 머리(x-user-*)를 단다.
//   응답 잃기(O-T10)는 이 중계가 위쪽 응답을 받은 뒤 소켓을 끊어 만든다(끊긴 횟수를 단언한다).
// - 스캐너 쪽은 apps/scanner의 진짜 모듈(판정·목록 상태·메모리 저장소·쓰는 차례·업로더·ScannerApi·DPoP)을 상대 경로 동적 가져오기로 쓴다
//   (ticket-svc 타입 검사에 DOM 형식이 없어 정적 import를 하지 않는다). ScannerApi는 Node fetch로 중계에 붙는다.
// 정본: docs/features/offline-gate.md §6.3 '변경분 판 1'·'POLICY를 적는 곳'·§6.4·§6.5 '업로드 첫 구현'·§7.1·§10.2, docs/data.md scanner_event_policy,
// O-T10·O-T15·O-T21 ③·O-T24·O-T25·O-T26, ASVS offline-gate 2.3.4. 판정은 바깥에서 본다: 응답, scan_event·gate_flag·scanner_change·scanner_event_policy 행, /metrics, 로그 줄.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { athOf, createDatabase, createHotRedis, systemClock, type Database, type HotRedis } from '@peaket/platform';
import { randomUUID, type webcrypto } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerDeviceStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-device-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import { RedisEnrollmentCodeStore } from '../src/modules/scanner/adapters/redis-enrollment-code-store.js';
import { enrollmentCodeHash, newEnrollmentCode } from '../src/modules/scanner/domain/scanner-device.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import type { PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';
import { start, type StartedService } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const RUN = randomUUID().slice(0, 8);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f5451';
const OPERATOR = '0190f3a1-7c2e-7a00-8000-0000000f5452';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000f5453';
const ASSIGNMENT = '0190f3a1-7c2e-7a00-8000-0000000f5454';
const FAN_SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5455';
/** E1 입장(재입장 불허), E2 재입장 허용, E3 POLICY 동시, E4 POLICY 장애, E5 core 못 닿음 */
const E1 = '0190f3a1-7c2e-7a00-8000-0000000f5461';
const E2 = '0190f3a1-7c2e-7a00-8000-0000000f5462';
const E3 = '0190f3a1-7c2e-7a00-8000-0000000f5463';
const E4 = '0190f3a1-7c2e-7a00-8000-0000000f5464';
const E5 = '0190f3a1-7c2e-7a00-8000-0000000f5465';
const API_HOST = 'scanner-api.peaket.example';
const API = `https://${API_HOST}`;
const PWA = 'https://scanner.f054.test';

// ---- 스캐너 앱 모듈(동적 가져오기) ----
const scannerPath = (p: string) => new URL(`../../../apps/scanner/src/${p}`, import.meta.url).href;
type Body = Record<string, unknown>;
interface DpopKey {
  privateKey: webcrypto.CryptoKey;
  publicJwk: webcrypto.JsonWebKey;
  jkt: string;
}
interface ScanQueue {
  put(r: unknown): Promise<void>;
  due(nowMs: number, limit: number): Promise<{ id: string; payload: string }[]>;
  count(): Promise<number>;
}
interface PackageStore {
  save(s: unknown): Promise<void>;
  nextDeviceSeq(): Promise<number>;
}
type PackageState = { lastSeq: number; entries: ReadonlyMap<string, unknown> } & Record<string, unknown>;
interface Api {
  package(eventId: string): Promise<Body & { lastSeq: number; tickets: { ticketId: string; keys: { keyId: string; publicKey: string }[] }[]; reentryAllowed: boolean }>;
  changes(eventId: string, after: number, limit?: number): Promise<{ changes: { seq: number; kind: string; payload: Body }[]; lastSeq: number; hasMore: boolean; versionVector: Body }>;
  uploadScans(scans: readonly Body[]): Promise<{ acceptedIds: string[]; resyncRequired: boolean }>;
}
interface Uploader {
  flushNow(): Promise<{ sent: number; accepted: number; deferred: number; tokenCleared: boolean }>;
}
interface Scanner {
  generateDpopKey(): Promise<DpopKey>;
  dpopProof(i: { key: DpopKey; method: string; url: string; token?: string; nowMs?: number }): Promise<string>;
  ScannerApi: new (o: { origin: string; key: DpopKey; token?: string; fetch?: typeof fetch }) => Api;
  MemoryScanQueue: new () => ScanQueue;
  MemoryPackageStore: new () => PackageStore;
  packageStateOf(pkg: unknown, placement: { gateZone: string; mode: 'IN' | 'OUT'; version: number }): PackageState;
  applyChangePage(state: PackageState, page: unknown, deviceId: string): PackageState;
  judgeScan(i: { raw: string; state: PackageState; nowMs: number; clockOffsetMs: number }): Promise<Body & { result: string }>;
  runScan(d: { raw: string; state: PackageState; store: PackageStore; queue: ScanQueue; nowMs: number; clockOffsetMs: number; scannerSessionId: string }): Promise<{
    outcome: Body & { result: string };
    state: PackageState;
    recorded: boolean;
  }>;
  ScanUploader: new (d: {
    queue: ScanQueue;
    port: { upload(batch: Body[], o: { withToken: boolean }): Promise<{ acceptedIds: string[]; resyncRequired: boolean }> };
    hasToken(): Promise<boolean>;
    clearToken(): Promise<void>;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(h: unknown): void;
    onState(s: unknown): void;
    onResync(): void;
    onSignedOut(): void;
  }) => Uploader;
}
let scannerMods: Partial<Scanner> = {};
/** 스캐너 모듈. 없으면 그 시험이 이 단언에서 떨어진다(파일 전체가 불러오기에서 멈추지 않는다) */
function scanner(): Scanner {
  for (const name of ['generateDpopKey', 'dpopProof', 'ScannerApi', 'MemoryScanQueue', 'MemoryPackageStore', 'packageStateOf', 'applyChangePage', 'judgeScan', 'runScan', 'ScanUploader'] as const) {
    expect(typeof scannerMods[name], `apps/scanner 모듈의 ${name}가 없다`).toBe('function');
  }
  return scannerMods as Scanner;
}
/** 지금도 있는 스캐너 모듈(기기 키·DPoP·ScannerApi)만 쓰는 준비 단계용. 서버 쪽 판정 시험이 새 앱 모듈 없음에 가려지지 않게 한다 */
function base(): Pick<Scanner, 'generateDpopKey' | 'dpopProof' | 'ScannerApi'> {
  for (const name of ['generateDpopKey', 'dpopProof', 'ScannerApi'] as const) expect(typeof scannerMods[name], `apps/scanner 모듈의 ${name}가 없다`).toBe('function');
  return scannerMods as Scanner;
}

// ---- 월렛 키·QR v1(offline-gate §3, 시험이 직접 만든다) ----
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function base45(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const n = bytes[i]! * 256 + bytes[i + 1]!;
    out += B45[n % 45]! + B45[Math.floor(n / 45) % 45]! + B45[Math.floor(n / 2025)]!;
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1]!;
    out += B45[n % 45]! + B45[Math.floor(n / 45)]!;
  }
  return out;
}
interface WalletKey {
  privateKey: webcrypto.CryptoKey;
  publicJwk: PublicKeyJwk;
  keyIdBytes: Uint8Array;
  compressed: string;
}
async function walletKey(): Promise<WalletKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const compressed = new Uint8Array(33);
  compressed[0] = (raw[64]! & 1) === 1 ? 0x03 : 0x02;
  compressed.set(raw.slice(1, 33), 1);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const keyIdBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', spki)).slice(0, 8);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as PublicKeyJwk, keyIdBytes, compressed: Buffer.from(compressed).toString('base64url') };
}
async function qrOf(k: WalletKey, ticketId: string, atMs: number): Promise<string> {
  const id = Buffer.from(ticketId.replace(/-/g, ''), 'hex');
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(Math.floor(atMs / 1000));
  const message = Buffer.concat([Buffer.from('PEAKET-QR-v1'), id, k.keyIdBytes, ts]);
  const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, message));
  return base45(new Uint8Array(Buffer.concat([Buffer.from([1]), id, k.keyIdBytes, ts, sig])));
}

// ---- identity-svc 자리 ----
type SessionAnswer = { valid: boolean; role: string; event_id: string; assignment_id: string; valid_from_ms: number; valid_until_ms: number; proxy: boolean; account_id: string };
const identity = { answers: new Map<string, SessionAnswer>(), server: undefined as grpc.Server | undefined, port: 0 };
async function startIdentityStandIn(): Promise<void> {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  // type-escape: proto-loader의 동적 패키지 정의는 형식이 없다(F-05-5 int 시험과 같다) F-05-4
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  const server = new grpc.Server();
  server.addService(pkg.ScannerSessionCheckService!.service, {
    CheckScannerSession: (call: grpc.ServerUnaryCall<{ scanner_session_id: string }, unknown>, cb: grpc.sendUnaryData<unknown>) => cb(null, identity.answers.get(call.request.scanner_session_id) ?? { valid: false }),
    TerminateScannerSessions: (_c: unknown, cb: grpc.sendUnaryData<unknown>) => cb(null, { terminated: 0 }),
  });
  identity.port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  identity.server = server;
}
/** 세션 하나. released면 계약대로 유효 창이 releasedAtMs에서 끝난 무효 답을 준다 */
function session(eventId: string, o: { released?: number } = {}): string {
  const id = randomUUID();
  const now = Date.now();
  identity.answers.set(id, {
    valid: o.released === undefined,
    role: 'STAFF_ROLE_GATE_STAFF',
    event_id: eventId,
    assignment_id: ASSIGNMENT,
    valid_from_ms: now - 3_600_000,
    valid_until_ms: o.released ?? now + 3_600_000,
    proxy: false,
    account_id: ACCOUNT,
  });
  return id;
}

// ---- core-svc 자리(회차 정책) ----
const core = { policy: new Map<string, boolean | 'down'>(), calls: new Map<string, number>(), server: undefined as Server | undefined, port: 0 };
async function startCoreStandIn(): Promise<void> {
  const server = createServer((req, res) => {
    const m = /^\/internal\/v1\/events\/([0-9a-f-]{36})\/sale-config$/.exec(req.url ?? '');
    if (!m) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    const eventId = m[1]!;
    core.calls.set(eventId, (core.calls.get(eventId) ?? 0) + 1);
    const p = core.policy.get(eventId);
    if (p === undefined) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    if (p === 'down') return void res.writeHead(503, { 'content-type': 'application/json' }).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ promoterId: PROMOTER, reentryAllowed: p, opensAtMs: 0, saleEndsAtMs: Date.now() + 86_400_000, endsAtMs: Date.now() + 86_400_000, entryOpensAtMs: null, entryClosedAtMs: null }));
  });
  core.port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  core.server = server;
}

// ---- gw-scanner 자리(중계) ----
const relay = { tokens: new Map<string, { sessionId: string; jkt: string }>(), dropScans: 0, drops: 0, server: undefined as Server | undefined, port: 0 };
async function startRelay(): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'content-length'].includes(k)) headers[k] = v;
      headers['x-forwarded-proto'] = 'https';
      headers['x-forwarded-host'] = API_HOST;
      headers.origin = PWA;
      headers['content-length'] = String(body.length);
      const auth = /^DPoP (.+)$/.exec(req.headers.authorization ?? '');
      const who = auth ? relay.tokens.get(auth[1]!) : undefined;
      if (auth && who) Object.assign(headers, { 'x-user-id': ACCOUNT, 'x-session-id': who.sessionId, 'x-user-aud': 'scanner', 'x-user-jkt': who.jkt, 'x-user-ath': athOf(auth[1]!) });
      const up = httpRequest({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers }, (ur) => {
        const out: Buffer[] = [];
        ur.on('data', (c: Buffer) => out.push(c));
        ur.on('end', () => {
          if (req.url === '/v1/scanner/scans' && relay.dropScans > 0) {
            relay.dropScans--;
            relay.drops++;
            req.socket.destroy(); // 위쪽은 받고 저장했는데, 앱에는 응답이 가지 않는다
            return;
          }
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(ur.headers)) if (typeof v === 'string' && !['connection', 'transfer-encoding'].includes(k)) h[k] = v;
          res.writeHead(ur.statusCode ?? 502, h).end(Buffer.concat(out));
        });
      });
      up.on('error', () => res.writeHead(502).end());
      up.end(body);
    });
  });
  relay.port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
  relay.server = server;
}
const relayFetch = (async (url: string | URL | Request, init?: RequestInit) => fetch(String(url).replace(API, `http://127.0.0.1:${relay.port}`), init)) as typeof fetch;

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

// ---- 상태 ----
let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let redis: HotRedis;
let svc: StartedService;
let appPort = 0;
let managementPort = 0;
let keys: DeviceKeys;
const logLines: Record<string, unknown>[] = [];

/** 기기 하나: 관제 등록(ops-svc gRPC)과 같은 결과(기기 원장 행·등록 코드 해시)를 저장소로 만들고, 공개 등록 경로(중계·PWA 출처·DPoP)로 키를 묶은 뒤 배치한다 */
interface Device {
  deviceId: string;
  key: DpopKey;
  token?: string;
}
async function device(eventId: string, mode: 'IN' | 'OUT' = 'IN'): Promise<Device> {
  const s = base();
  const deviceId = randomUUID();
  const code = newEnrollmentCode();
  await new DrizzleScannerDeviceStore(database).register({ deviceId, name: `f054-${RUN}-${deviceId.slice(0, 8)}`, promoterId: PROMOTER, enrolledBy: OPERATOR, atMs: Date.now() });
  await new RedisEnrollmentCodeStore(redis).put({ codeHash: enrollmentCodeHash(code), deviceId, ttlMs: 600_000 });
  const key = await s.generateDpopKey();
  const url = `${API}/v1/scanner/device-enrollments`;
  const r = await relayFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', dpop: await s.dpopProof({ key, method: 'POST', url }) }, body: JSON.stringify({ code }) });
  expect(r.status, '기기 등록').toBe(201);
  await new DrizzleScannerShiftStore(database).putPlacement({ eventId, deviceId, gateZone: '동문', mode, setBy: OPERATOR, atMs: Date.now(), expectedVersion: 0 });
  return { deviceId, key };
}

/** 스태프 토큰 하나(중계가 이 토큰을 그 세션·기기 지문으로 바꾼다) */
function tokenFor(d: Device, sessionId: string): string {
  const token = `f054-${randomUUID()}`;
  relay.tokens.set(token, { sessionId, jkt: d.key.jkt });
  return token;
}
const apiFor = (d: Device, token?: string): Api => new (base().ScannerApi)({ origin: API, key: d.key, ...(token ? { token } : {}), fetch: relayFetch });

/** 실제 ScannerApi 위의 업로드 포트와 업로더(타이머는 쓰지 않고 flushNow만 부른다) */
function uploaderFor(d: Device, queue: ScanQueue) {
  const log = { calls: [] as { ids: string[]; withToken: boolean }[], cleared: 0, signedOut: 0 };
  const uploader = new (scanner().ScanUploader)({
    queue,
    port: {
      upload: (batch, o) => {
        log.calls.push({ ids: batch.map((b) => String(b.id)), withToken: o.withToken });
        return apiFor(d, o.withToken ? d.token : undefined).uploadScans(batch);
      },
    },
    hasToken: async () => d.token !== undefined,
    clearToken: async () => {
      log.cleared++;
      delete d.token;
    },
    now: () => Date.now(),
    setTimer: () => 0,
    clearTimer: () => undefined,
    onState: () => undefined,
    onResync: () => undefined,
    onSignedOut: () => void log.signedOut++,
  });
  return { uploader, log };
}

async function ticket(eventId: string): Promise<{ ticketId: string; wallet: WalletKey }> {
  const ticketId = randomUUID();
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', now())`,
    [ticketId, ACCOUNT, randomUUID(), eventId, randomUUID()],
  );
  const wallet = await walletKey();
  await keys.register({ ticketId, accountId: ACCOUNT, sessionId: FAN_SESSION, publicKeyJwk: wallet.publicJwk, reason: 'ISSUE' });
  return { ticketId, wallet };
}

const IN_PLACEMENT = { gateZone: '동문', mode: 'IN' as const, version: 1 };
const OUT_PLACEMENT = { gateZone: '동문', mode: 'OUT' as const, version: 1 };

async function metric(name: string, labels: Record<string, string>): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`)) continue;
    if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
    sum += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return sum;
}
const received = (result: string) => metric('scanner_scans_received_total', { service: 'ticket-svc', result });
const rowsFor = async (ids: string[]) =>
  (await database.pool.query('select id::text, result, flag, known_seq::int, device_seq::int from scan_event where id = any($1::uuid[]) order by id', [ids])).rows as {
    id: string;
    result: string;
    flag: string;
    known_seq: number;
    device_seq: number;
  }[];
const idsIn = async (q: ScanQueue) => (await q.due(Number.MAX_SAFE_INTEGER, 1000)).map((r) => r.id);
const policyRows = async (eventId: string) => (await database.pool.query("select seq::int, payload from scanner_change where event_id = $1 and kind = 'POLICY' order by seq", [eventId])).rows as { seq: number; payload: Body }[];
const policyCopy = async (eventId: string) => (await database.pool.query('select reentry_allowed, policy_seq::int from scanner_event_policy where event_id = $1', [eventId])).rows as { reentry_allowed: boolean; policy_seq: number }[];
const lastSeqOf = async (eventId: string) => ((await database.pool.query('select last_seq::int from scanner_seq where event_id = $1', [eventId])).rows[0] as { last_seq: number } | undefined)?.last_seq ?? 0;

beforeAll(async () => {
  [pg, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-f054-int', max: 6 });
  const gateStore = new DrizzleScannerGateStore(database);
  keys = new DeviceKeys({ store: new DrizzleDeviceKeyStore({ database, changes: gateStore }), clock: systemClock });
  await startIdentityStandIn();
  await startCoreStandIn();
  await startRelay();
  core.policy.set(E1, false);
  core.policy.set(E2, true);
  scannerMods = {
    ...((await import(/* @vite-ignore */ scannerPath('api/dpop.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('api/client.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('storage/scan-queue.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('storage/package-store.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('storage/package-state.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('judge/judge.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('judge/scan-flow.ts')).catch(() => ({}))) as object),
    ...((await import(/* @vite-ignore */ scannerPath('sync/uploader.ts')).catch(() => ({}))) as object),
  } as Partial<Scanner>;
  redis = await createHotRedis({ url: valkey.url });
  appPort = await freePort();
  managementPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_DATABASE_URL: pg.url,
      PEAKET_TICKET_REDIS_URL: valkey.url,
      PEAKET_IDENTITY_GRPC_URL: `127.0.0.1:${identity.port}`,
      PEAKET_CORE_HTTP_URL: `http://127.0.0.1:${core.port}`,
      PEAKET_SCANNER_PWA_ORIGIN: PWA,
      PORT: String(appPort),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'info',
    },
    logDestination: new Writable({
      write: (c: Buffer, _e, cb) => {
        for (const line of c.toString('utf8').split('\n')) {
          try {
            if (line) logLines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // 줄이 JSON이 아니면 버린다
          }
        }
        cb();
      },
    }),
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => {});
  await redis?.close().catch(() => {});
  identity.server?.forceShutdown();
  await new Promise((r) => (core.server ? core.server.close(r) : r(undefined)));
  await new Promise((r) => (relay.server ? relay.server.close(r) : r(undefined)));
  await database?.close().catch(() => {});
  valkey?.stop();
  pg?.stop();
});

describe('F-05-4 실제 ticket-svc(start)와 스캐너 앱 모듈', () => {
  test('O-T10 응답을 잃은 묶음(서버는 저장, 앱은 끊김)을 다시 보내면 scan_event 행은 묶음 수 그대로이고 duplicate 지표가 묶음 수만큼 오르며 큐가 빈다', async () => {
    const s = scanner();
    const d = await device(E1);
    const tickets = await Promise.all([ticket(E1), ticket(E1), ticket(E1)]);
    const sid = session(E1);
    let state = s.packageStateOf(await apiFor(d, tokenFor(d, sid)).package(E1), IN_PLACEMENT);
    const store = new s.MemoryPackageStore();
    await store.save(state);
    const queue = new s.MemoryScanQueue();
    for (const t of tickets) {
      const now = Date.now();
      const r = await s.runScan({ raw: await qrOf(t.wallet, t.ticketId, now), state, store, queue, nowMs: now, clockOffsetMs: 0, scannerSessionId: sid });
      expect(r.outcome.result).toBe('PASS');
      state = r.state;
    }
    const ids = await idsIn(queue);
    expect(ids).toHaveLength(3);
    const dup0 = await received('duplicate');
    const pass0 = await received('PASS');
    relay.dropScans = 1;
    const { uploader } = uploaderFor(d, queue);
    const first = await uploader.flushNow();
    expect(relay.drops, '중계가 응답을 실제로 끊었다').toBe(1);
    expect(first).toMatchObject({ sent: 3, accepted: 0, deferred: 3 });
    expect(await queue.count()).toBe(3);
    expect((await rowsFor(ids)).map((r) => r.id)).toEqual([...ids].sort());
    const second = await uploader.flushNow();
    expect(second).toMatchObject({ sent: 3, accepted: 3, deferred: 0 });
    expect(await queue.count()).toBe(0);
    expect(await rowsFor(ids)).toHaveLength(3);
    expect(await received('duplicate')).toBe(dup0 + 3);
    expect(await received('PASS')).toBe(pass0 + 3);
  });

  test('O-T26 O-T21 ③ 해제 전후 판정 12건(해제 뒤 시각 5건)을 해제된 토큰으로 올리면 401 뒤 토큰을 지우고 기기 인증으로 12건 모두 받으며 세션 밖 기록이 5건이다', async () => {
    const s = scanner();
    const d = await device(E1);
    const tickets = await Promise.all(Array.from({ length: 12 }, () => ticket(E1)));
    // 목록은 유효한 다른 세션으로 받는다(가드의 세션 판정 캐시가 해제된 세션 답에 섞이지 않게)
    const pkg = await apiFor(d, tokenFor(d, session(E1))).package(E1);
    const releasedAt = Date.now() - 120_000;
    const released = session(E1, { released: releasedAt });
    d.token = tokenFor(d, released);
    let state = s.packageStateOf(pkg, IN_PLACEMENT);
    const store = new s.MemoryPackageStore();
    await store.save(state);
    const queue = new s.MemoryScanQueue();
    for (const [i, t] of tickets.entries()) {
      // 앞 7건은 해제 전(해제 90초~60초 전), 뒤 5건은 해제 뒤(해제 30초~70초 뒤)
      const at = i < 7 ? releasedAt - 90_000 + i * 5_000 : releasedAt + 30_000 + (i - 7) * 10_000;
      const r = await s.runScan({ raw: await qrOf(t.wallet, t.ticketId, at), state, store, queue, nowMs: at, clockOffsetMs: 0, scannerSessionId: released });
      expect(r.outcome.result, `판정 ${i}`).toBe('PASS');
      state = r.state;
    }
    const ids = await idsIn(queue);
    expect(ids).toHaveLength(12);
    const pass0 = await received('PASS');
    const dup0 = await received('duplicate');
    const { uploader, log } = uploaderFor(d, queue);
    const r = await uploader.flushNow();
    expect(log.calls.map((c) => c.withToken)).toEqual([true, false]);
    expect(log.calls[1]!.ids).toEqual(log.calls[0]!.ids);
    expect(log.cleared).toBe(1);
    expect(log.signedOut).toBe(1);
    expect(r).toMatchObject({ sent: 12, accepted: 12, deferred: 0, tokenCleared: true });
    expect(await queue.count()).toBe(0);
    const rows = await rowsFor(ids);
    expect(rows).toHaveLength(12);
    expect(rows.filter((x) => x.flag === 'OUT_OF_SESSION')).toHaveLength(5);
    expect(await received('PASS')).toBe(pass0 + 12);
    expect(await received('duplicate')).toBe(dup0);
  });

  test('GAT-160 두 기기가 같은 티켓을 오프라인으로 통과시키고 동시에 올리면 기록 둘·중복 입장 표시 하나이고 저장된 known_seq·device_seq가 보낸 값이다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = scanner();
    const [c, dv] = [await device(E1), await device(E1)];
    const t = await ticket(E1);
    const [sc, sd] = [session(E1), session(E1)];
    const pkgC = await apiFor(c, tokenFor(c, sc)).package(E1);
    await ticket(E1); // 그 사이 변경(KEY_REGISTERED) 하나로 두 기기의 knownSeq를 다르게 한다
    const pkgD = await apiFor(dv, tokenFor(dv, sd)).package(E1);
    expect(pkgD.lastSeq).toBeGreaterThan(pkgC.lastSeq);
    const stores = [new s.MemoryPackageStore(), new s.MemoryPackageStore()];
    await stores[1]!.nextDeviceSeq();
    await stores[1]!.nextDeviceSeq();
    const queues = [new s.MemoryScanQueue(), new s.MemoryScanQueue()];
    const now = Date.now();
    const [rc, rd] = await Promise.all([
      s.runScan({ raw: await qrOf(t.wallet, t.ticketId, now), state: s.packageStateOf(pkgC, IN_PLACEMENT), store: stores[0]!, queue: queues[0]!, nowMs: now, clockOffsetMs: 0, scannerSessionId: sc }),
      s.runScan({ raw: await qrOf(t.wallet, t.ticketId, now + 1_000), state: s.packageStateOf(pkgD, IN_PLACEMENT), store: stores[1]!, queue: queues[1]!, nowMs: now + 1_000, clockOffsetMs: 0, scannerSessionId: sd }),
    ]);
    expect([rc.outcome.result, rd.outcome.result]).toEqual(['PASS', 'PASS']);
    const [idC] = await idsIn(queues[0]!);
    const [idD] = await idsIn(queues[1]!);
    const [uc, ud] = [uploaderFor(c, queues[0]!), uploaderFor(dv, queues[1]!)];
    const [a, b] = await Promise.all([uc.uploader.flushNow(), ud.uploader.flushNow()]);
    expect([a.accepted, b.accepted]).toEqual([1, 1]);
    const rows = await rowsFor([idC!, idD!]);
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.known_seq, r.device_seq]]))).toEqual({ [idC!]: [pkgC.lastSeq, 1], [idD!]: [pkgD.lastSeq, 3] });
    const flags = (await database.pool.query("select kind from gate_flag where ticket_id = $1 and kind = 'DUPLICATE'", [t.ticketId])).rows;
    expect(flags).toHaveLength(1);
  });

  test('O-T24 재입장 허용 회차에서 기기 Y 입장 → 기기 X 퇴장(OUT) → Y가 변경분 SCAN_STATE OUT을 반영해 다시 입장(IN)하면 셋 다 통과이고 이상 표시가 0줄이다', async () => {
    const s = scanner();
    const y = await device(E2, 'IN');
    const x = await device(E2, 'OUT');
    const t = await ticket(E2);
    const [sy, sx] = [session(E2), session(E2)];
    const tokenY = tokenFor(y, sy);
    const tokenX = tokenFor(x, sx);
    const base = Date.now() - 120_000;
    const scanOn = async (d: Device, state: PackageState, at: number) => {
      const sid = d === y ? sy : sx;
      const queue = new s.MemoryScanQueue();
      const store = new s.MemoryPackageStore();
      await store.save(state);
      const r = await s.runScan({ raw: await qrOf(t.wallet, t.ticketId, at), state, store, queue, nowMs: at, clockOffsetMs: 0, scannerSessionId: sid });
      const up = await uploaderFor(d, queue).uploader.flushNow();
      expect(up.accepted).toBe(1);
      return r;
    };
    const pkgY = await apiFor(y, tokenY).package(E2);
    expect(pkgY.reentryAllowed).toBe(true);
    const stateY = s.packageStateOf(pkgY, IN_PLACEMENT);
    const first = await scanOn(y, stateY, base);
    expect([first.outcome.result, first.outcome.direction]).toEqual(['PASS', 'IN']);
    const out = await scanOn(x, s.packageStateOf(await apiFor(x, tokenX).package(E2), OUT_PLACEMENT), base + 60_000);
    expect([out.outcome.result, out.outcome.direction]).toEqual(['PASS', 'OUT']);
    const page = await apiFor(y, tokenY).changes(E2, first.state.lastSeq);
    expect(page.changes.filter((c) => c.kind === 'SCAN_STATE' && c.payload.ticketId === t.ticketId).map((c) => c.payload.direction)).toContain('OUT');
    const again = await scanOn(y, s.applyChangePage(first.state, page, y.deviceId), base + 90_000);
    expect([again.outcome.result, again.outcome.direction]).toEqual(['PASS', 'IN']);
    expect((await database.pool.query('select count(*)::int as n from scan_event where ticket_id = $1', [t.ticketId])).rows[0].n).toBe(3);
    expect((await database.pool.query('select count(*)::int as n from gate_flag where ticket_id = $1', [t.ticketId])).rows[0].n).toBe(0);
  });

  test('O-T25 목록을 받은 뒤 등록한 키는 변경분 KEY_REGISTERED에 목록 keys[].publicKey와 같은 publicKey로 실리고, 반영 전 KEY_UNKNOWN이던 QR이 반영 뒤 통과한다', async () => {
    const d = await device(E1);
    const token = tokenFor(d, session(E1));
    const ticketId = randomUUID();
    await database.pool.query(
      `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
       values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', now())`,
      [ticketId, ACCOUNT, randomUUID(), E1, randomUUID()],
    );
    const beforePkg = await apiFor(d, token).package(E1);
    const wallet = await walletKey();
    await keys.register({ ticketId, accountId: ACCOUNT, sessionId: FAN_SESSION, publicKeyJwk: wallet.publicJwk, reason: 'ISSUE' });
    const page = await apiFor(d, token).changes(E1, beforePkg.lastSeq);
    const reg = page.changes.filter((c) => c.kind === 'KEY_REGISTERED' && c.payload.ticketId === ticketId);
    expect(reg).toHaveLength(1);
    const fresh = await apiFor(d, token).package(E1);
    const listed = fresh.tickets.find((x) => x.ticketId === ticketId)!.keys;
    expect(listed[0]!.publicKey).toBe(wallet.compressed);
    expect(reg[0]!.payload).toEqual({ v: 1, ticketId, keyId: Buffer.from(wallet.keyIdBytes).toString('base64url'), publicKey: listed[0]!.publicKey });
    // 앱: 반영 전 목록으로는 키 미반영, 변경분 반영 뒤 통과
    const s = scanner();
    const before = s.packageStateOf(beforePkg, IN_PLACEMENT);
    const now = Date.now();
    const raw = await qrOf(wallet, ticketId, now);
    expect((await s.judgeScan({ raw, state: before, nowMs: now, clockOffsetMs: 0 })).reason).toBe('KEY_UNKNOWN');
    const after = s.applyChangePage(before, page, d.deviceId);
    expect((await s.judgeScan({ raw, state: after, nowMs: now, clockOffsetMs: 0 })).result).toBe('PASS');
  });

  test('O-T15 core 정책이 불허 → 허용으로 바뀐 뒤 변경분 요청 둘이 동시에 와도 POLICY는 한 줄이고 사본·policy_seq·지표·로그 줄이 그 한 번을 적는다', async () => {
    const d = await device(E3);
    const t1 = tokenFor(d, session(E3));
    const t2 = tokenFor(d, session(E3));
    // 사본은 불허(처음 만들 때 policy_seq 0, docs/data.md). core는 이미 허용이다
    await database.pool.query('insert into scanner_event_policy (event_id, reentry_allowed, policy_seq, observed_at) values ($1, false, 0, now())', [E3]);
    core.policy.set(E3, true);
    const metric0 = await metric('scanner_policy_changes_total', { service: 'ticket-svc' });
    const logs0 = logLines.length;
    const [a, b] = await Promise.all([apiFor(d, t1).changes(E3, 0), apiFor(d, t2).changes(E3, 0)]);
    const rows = await policyRows(E3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ v: 1, reentryAllowed: true });
    expect([...a.changes, ...b.changes].filter((c) => c.kind === 'POLICY').map((c) => c.seq)).toContain(rows[0]!.seq);
    expect(await policyCopy(E3)).toEqual([{ reentry_allowed: true, policy_seq: rows[0]!.seq }]);
    expect(await metric('scanner_policy_changes_total', { service: 'ticket-svc' })).toBe(metric0 + 1);
    const lines = logLines.slice(logs0).filter((l) => l.msg === 'scanner.policy-changed' || l.kind === 'scanner.policy-changed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ eventId: E3, reentryAllowed: true, seq: rows[0]!.seq });
    // 같은 값을 다시 보면 늘지 않는다
    await apiFor(d, t1).changes(E3, 0);
    expect(await policyRows(E3)).toHaveLength(1);
  });

  test('O-T15 POLICY를 적는 scanner_change 넣기가 한 번 실패하면 번호·사본이 그대로이고, 장애를 걷은 다음 요청에 한 줄이 적힌다', async () => {
    const d = await device(E4);
    const token = tokenFor(d, session(E4));
    await database.pool.query('insert into scanner_event_policy (event_id, reentry_allowed, policy_seq, observed_at) values ($1, false, 0, now())', [E4]);
    await database.pool.query(`
      create sequence f054_policy_fault_seq;
      create function f054_fail_policy() returns trigger language plpgsql as $$
      begin
        if new.kind = 'POLICY' and new.event_id = '${E4}' then
          perform nextval('f054_policy_fault_seq');
          raise exception 'f054 fault: scanner_change insert failed';
        end if;
        return new;
      end $$;
      create trigger f054_fail_policy before insert on scanner_change for each row execute function f054_fail_policy();
    `);
    core.policy.set(E4, true);
    const seq0 = await lastSeqOf(E4);
    try {
      await apiFor(d, token)
        .changes(E4, 0)
        .catch((e: unknown) => e);
      const seqRow = (await database.pool.query('select last_value::int as n, is_called from f054_policy_fault_seq')).rows[0] as { n: number; is_called: boolean };
      const fired = seqRow.is_called ? seqRow.n : 0;
      expect(fired, '장애 트리거가 실제로 던졌다').toBe(1);
      expect(await lastSeqOf(E4)).toBe(seq0);
      expect(await policyCopy(E4)).toEqual([{ reentry_allowed: false, policy_seq: 0 }]);
      expect(await policyRows(E4)).toEqual([]);
    } finally {
      await database.pool.query('drop trigger f054_fail_policy on scanner_change; drop function f054_fail_policy();');
    }
    const ok = await apiFor(d, token).changes(E4, 0);
    const rows = await policyRows(E4);
    expect(rows).toHaveLength(1);
    expect(ok.changes.filter((c) => c.kind === 'POLICY')).toEqual([{ seq: rows[0]!.seq, kind: 'POLICY', payload: { v: 1, reentryAllowed: true } }]);
    expect(await policyCopy(E4)).toEqual([{ reentry_allowed: true, policy_seq: rows[0]!.seq }]);
  });

  test('O-T15 core에 닿지 못하면 목록의 reentryAllowed는 사본 값(허용)이고 변경분이 없다', async () => {
    const d = await device(E5);
    const token = tokenFor(d, session(E5));
    await database.pool.query('insert into scanner_event_policy (event_id, reentry_allowed, policy_seq, observed_at) values ($1, true, 0, now())', [E5]);
    core.policy.set(E5, 'down');
    const pkg = await apiFor(d, token).package(E5);
    expect((core.calls.get(E5) ?? 0) > 0, 'core 대역에 실제로 물었다').toBe(true);
    expect(pkg.reentryAllowed).toBe(true);
    expect(await policyRows(E5)).toEqual([]);
    expect(await lastSeqOf(E5)).toBe(0);
  });
});
