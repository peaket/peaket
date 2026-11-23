// F-05-5(GAT-170 마감) 실제 서버 연결 시험: 시작 파일 start()로 ticket-svc를 띄우고(실제 PostgreSQL·Valkey, HTTP·관리·gRPC 포트),
// ops-svc의 실제 gRPC 클라이언트(GrpcTicketScannerDevices, 의존 선언 밖 상대 경로)로 기기를 등록·폐기·코드 재발급하며,
// identity-svc 자리는 계약(identity.proto ScannerSessionCheckService) 모양 gRPC 대역 서버다(답을 시험이 바꾸고, 멈출 수 있다).
// 정본: docs/features/offline-gate.md §6.1 'GAT-170 마감 규칙'·§6.2·§6.5·§6.6, O-T21 ①②·O-T35·O-T37 ①~⑨·O-T42 ⑤, 계획 docs/review/plans/F-05-5.md §6·§8.
// 판정은 바깥에서 본다: 응답 + 그 뒤 scan_event 행 수(기록이 저장되지 않음), 관리 포트 /metrics의 scanner_auth_rejections_total, Redis의 등록 코드 키.
// 시계는 실제 시계다(start()가 systemClock을 쓴다). 경계값(iat ±300,000ms·캐시 4,999/5,000ms)은 platform 단위 시험(scanner-auth-f055.test.ts)이 가짜 시계로 본다.
// 허용 출처는 시작 환경 PEAKET_SCANNER_PWA_ORIGIN으로 기본값과 다른 값을 준다(시작 파일이 그 값을 잇는지 본다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { athOf, createDatabase, createHotRedis, type Database, type HotRedis } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcTicketScannerDevices } from '../../ops-svc/src/modules/scanner-devices/adapters/grpc-ticket-scanner-devices.js';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import { enrollmentCodeHash } from '../src/modules/scanner/domain/scanner-device.js';
import { start, type StartedService } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const RUN = randomUUID().slice(0, 8);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f0551';
const OPERATOR = '0190f3a1-7c2e-7a00-8000-0000000f0552';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000f0553';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f0554';
const TICKET = '0190f3a1-7c2e-7a00-8000-0000000f0555';
const ASSIGNMENT = '0190f3a1-7c2e-7a00-8000-0000000f0556';
const API_HOST = 'scanner-api.peaket.example';
/** 시작 환경으로 바꾼 스캐너 PWA 출처(기본값 https://scanner.peaket.example과 다르게 골랐다) */
const PWA = 'https://scanner.f055.test';
const DEFAULT_PWA = 'https://scanner.peaket.example';
const TOKEN = 'f055-staff-token';
const ATH = athOf(TOKEN);

// ---- identity-svc 자리: ScannerSessionCheckService 계약 대역 ----
type SessionAnswer = { valid: boolean; role?: 'STAFF_ROLE_GATE_STAFF' | 'STAFF_ROLE_GATE_LEAD'; event_id?: string; assignment_id?: string; valid_from_ms?: number; valid_until_ms?: number; proxy?: boolean; account_id?: string };
const identity = {
  answers: new Map<string, SessionAnswer>(),
  checks: [] as { scanner_session_id: string; device_id: string }[],
  terminates: [] as { device_id: string; reason: string }[],
  terminateFails: false,
  server: undefined as grpc.Server | undefined,
  port: 0,
};

async function startIdentityStandIn(): Promise<void> {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  const server = new grpc.Server();
  server.addService(pkg.ScannerSessionCheckService!.service, {
    CheckScannerSession: (call: grpc.ServerUnaryCall<{ scanner_session_id: string; device_id: string }, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      identity.checks.push({ scanner_session_id: call.request.scanner_session_id, device_id: call.request.device_id });
      cb(null, identity.answers.get(call.request.scanner_session_id) ?? { valid: false });
    },
    TerminateScannerSessions: (call: grpc.ServerUnaryCall<{ device_id: string; reason: string }, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      identity.terminates.push({ device_id: call.request.device_id, reason: call.request.reason });
      if (identity.terminateFails) return cb({ code: grpc.status.UNAVAILABLE, details: '시험이 넣은 장애' } as grpc.ServiceError);
      cb(null, { terminated: 1 });
    },
  });
  identity.port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  identity.server = server;
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

// ---- 기기 키·증명 ----
interface Key {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(key: Key, o: { htm: string; path: string; jti?: string; iatSec?: number; ath?: string; htu?: string }): Promise<string> {
  return new SignJWT({
    jti: o.jti ?? randomUUID(),
    htm: o.htm,
    htu: o.htu ?? `https://${API_HOST}${o.path.split('?')[0]}`,
    iat: o.iatSec ?? Math.floor(Date.now() / 1000),
    ...(o.ath !== undefined ? { ath: o.ath } : {}),
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
}

// ---- 상태 ----
let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let redis: HotRedis;
let svc: StartedService;
let ops: GrpcTicketScannerDevices;
let appPort = 0;
let managementPort = 0;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** 실제 HTTP 요청(Origin 머리를 그대로 보내려고 node:http를 쓴다) */
function call(method: string, path: string, headers: Record<string, string>, body?: unknown, rawBody?: string): Promise<Reply> {
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: appPort,
        method,
        path,
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': API_HOST, ...headers, ...(payload !== undefined ? { 'content-length': String(Buffer.byteLength(payload)) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const scanRows = async (): Promise<number> => Number((await database.pool.query('select count(*)::int as n from scan_event')).rows[0].n);
const pttl = async (key: string): Promise<number> => Number(await redis.command(['PTTL', key], { key }));

/** 관리 포트 /metrics에서 scanner_auth_rejections_total{service="ticket-svc",reason} 값(줄이 없으면 0) */
async function rejections(reason: string): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('scanner_auth_rejections_total{')) continue;
    if (!line.includes(`reason="${reason}"`) || !line.includes('service="ticket-svc"')) continue;
    return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return 0;
}

/** 관제 등록(ops-svc gRPC) → 공개 등록(PWA 출처·DPoP). 기기 ID·키·등록 코드 */
let ipSeq = 0;
async function enrolledDevice(name: string, ip = `10.55.0.${++ipSeq}`): Promise<{ deviceId: string; key: Key }> {
  const reg = await ops.register({ requestId: randomUUID(), name: `${name}-${RUN}`, promoterId: PROMOTER, actedBy: OPERATOR });
  const key = await keyOf();
  const r = await enroll(key, reg.enrollmentCode!, { ip });
  expect(r.status, `${name} 등록`).toBe(201);
  return { deviceId: reg.device.deviceId, key };
}

async function enroll(key: Key, code: string, o: { origin?: string | null; ip?: string; jti?: string } = {}): Promise<Reply> {
  const path = '/v1/scanner/device-enrollments';
  return call(
    'POST',
    path,
    {
      'content-type': 'application/json',
      dpop: await proofOf(key, { htm: 'POST', path, ...(o.jti ? { jti: o.jti } : {}) }),
      'x-forwarded-for': o.ip ?? '10.66.0.1',
      ...(o.origin === null ? {} : { origin: o.origin ?? PWA }),
    },
    { code },
  );
}

async function place(deviceId: string): Promise<void> {
  await new DrizzleScannerShiftStore(database).putPlacement({ eventId: EVENT, deviceId, gateZone: '동문', mode: 'IN', setBy: OPERATOR, atMs: Date.now(), expectedVersion: 0 });
}

/**
 * identity 대역의 답을 정한다. 해제된 세션(valid=false)은 identity 계약대로 역할·회차·유효 창을 채우되, 창은 해제 시각(1분 전)에서 끝난다
 * (identity.proto CheckScannerSessionResponse 설명, offline-gate §6.5: ticket-svc가 기록 시각이 창 안인지 다시 판정한다)
 */
function session(id: string, role: 'STAFF_ROLE_GATE_STAFF' | 'STAFF_ROLE_GATE_LEAD' = 'STAFF_ROLE_GATE_LEAD', valid = true): string {
  const until = valid ? Date.now() + 3_600_000 : Date.now() - 60_000;
  identity.answers.set(id, { valid, role, event_id: EVENT, assignment_id: ASSIGNMENT, valid_from_ms: Date.now() - 3_600_000, valid_until_ms: until, proxy: false, account_id: ACCOUNT });
  return id;
}

async function staffHeaders(key: Key, htm: string, path: string, sessionId: string, o: { jkt?: string; proof?: string; iatSec?: number; htm?: string; htu?: string } = {}): Promise<Record<string, string>> {
  return {
    'x-user-id': ACCOUNT,
    'x-session-id': sessionId,
    'x-user-aud': 'scanner',
    'x-user-jkt': o.jkt ?? key.jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    dpop: o.proof ?? (await proofOf(key, { htm: o.htm ?? htm, path, ath: ATH, ...(o.iatSec !== undefined ? { iatSec: o.iatSec } : {}), ...(o.htu ? { htu: o.htu } : {}) })),
    origin: PWA,
  };
}

let seq = 0;
const scan = (sessionId: string) => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId: TICKET,
  scannerSessionId: sessionId,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date().toISOString(),
  knownSeq: 0,
  deviceSeq: ++seq,
});

async function uploadWithToken(key: Key, sessionId: string, o: { jkt?: string; proof?: string; iatSec?: number; htm?: string; htu?: string } = {}): Promise<Reply> {
  return call('POST', '/v1/scanner/scans', { ...(await staffHeaders(key, 'POST', '/v1/scanner/scans', sessionId, o)), 'content-type': 'application/json' }, [scan(sessionId)]);
}

async function uploadDeviceOnly(key: Key, batch: unknown[], proof?: string): Promise<Reply> {
  const path = '/v1/scanner/scans';
  return call('POST', path, { dpop: proof ?? (await proofOf(key, { htm: 'POST', path })), origin: PWA, 'content-type': 'application/json' }, batch);
}

const problemType = (r: Reply): unknown => r.body.type;

beforeAll(async () => {
  [pg, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-f055-int', max: 4 });
  redis = await createHotRedis({ url: valkey.url });
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', now())`,
    [TICKET, ACCOUNT, randomUUID(), EVENT, randomUUID()],
  );
  // 장애 주입 자리(O-T42 ⑤): f055_fault_target에 적은 기기의 키를 묶는 UPDATE를 시퀀스가 1 이하일 때 한 번 실패시킨다.
  // 시퀀스는 거래 되돌림과 상관없이 오르므로 '한 번만'이 지켜진다. 실패는 일반 DB 오류(키 겹침 23505가 아니다)다.
  await database.pool.query(`
    create table f055_fault_target (device_id uuid primary key);
    create sequence f055_fault_seq;
    create function f055_fail_bind() returns trigger language plpgsql as $$
    begin
      if new.id in (select device_id from f055_fault_target) and new.credential_thumbprint is distinct from old.credential_thumbprint then
        if nextval('f055_fault_seq') <= 1 then
          raise exception 'f055 fault: connection terminated unexpectedly';
        end if;
      end if;
      return new;
    end $$;
    create trigger f055_fail_bind before update on scanner_device for each row execute function f055_fail_bind();
  `);
  await startIdentityStandIn();
  appPort = await freePort();
  managementPort = await freePort();
  const grpcPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_DATABASE_URL: pg.url,
      PEAKET_TICKET_REDIS_URL: valkey.url,
      PEAKET_IDENTITY_GRPC_URL: `127.0.0.1:${identity.port}`,
      PEAKET_SCANNER_PWA_ORIGIN: PWA,
      PORT: String(appPort),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_PORT: String(grpcPort),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 5).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  ops = new GrpcTicketScannerDevices({ address: `127.0.0.1:${svc.ports.grpcPort}` });
}, 180_000);

afterAll(async () => {
  ops?.close();
  await svc?.close().catch(() => {});
  identity.server?.forceShutdown();
  await redis?.close().catch(() => {});
  await database?.close().catch(() => {});
  valkey?.stop();
  pg?.stop();
});

describe('F-05-5 실제 ticket-svc(start) 스캐너 기기 등록·증명·세션 확인', () => {
  test('O-T37 ① ops-svc gRPC로 기기를 만들고 PWA 출처·DPoP로 공개 등록(201)하면, 그 키와 스태프 토큰의 근무 준비가 통과한다', async () => {
    const reg = await ops.register({ requestId: randomUUID(), name: `동문-01-${RUN}`, promoterId: PROMOTER, actedBy: OPERATOR });
    expect(reg.device).toMatchObject({ status: 'ACTIVE', credentialType: 'DEVICE_KEY', promoterId: PROMOTER });
    expect(reg.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    const key = await keyOf();
    const enrollJti = randomUUID();
    const r = await enroll(key, reg.enrollmentCode!, { jti: enrollJti });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ deviceId: reg.device.deviceId });
    const row = (await database.pool.query('select credential_thumbprint, status from scanner_device where id = $1', [reg.device.deviceId])).rows[0];
    expect({ jkt: Buffer.from(row.credential_thumbprint).toString('base64url'), status: row.status }).toEqual({ jkt: key.jkt, status: 'ACTIVE' });

    await place(reg.device.deviceId);
    const s = session(randomUUID());
    const shift = await call('GET', '/v1/scanner/shift', await staffHeaders(key, 'GET', '/v1/scanner/shift', s));
    expect(shift.status).toBe(200);
    expect(shift.body).toMatchObject({ eventId: EVENT, device: { deviceId: reg.device.deviceId, status: 'ACTIVE', enrolled: true }, auth: { deviceProof: 'DPOP', staffSession: true } });
    expect(identity.checks).toContainEqual({ scanner_session_id: s, device_id: reg.device.deviceId });

    // 등록 처리기와 가드가 같은 jti 저장소를 쓴다: 등록 증명의 jti를 업로드에 다시 쓰면 401이다(겹친 가드)
    const before = await scanRows();
    const reused = await uploadWithToken(key, s, { proof: await proofOf(key, { htm: 'POST', path: '/v1/scanner/scans', jti: enrollJti, ath: ATH }) });
    expect(reused.status).toBe(401);
    expect(reused.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(await scanRows()).toBe(before);
  });

  test('O-T35 ⑤ 시작 환경이 허용 출처를 바꾸면 기본 출처(https://scanner.peaket.example)의 등록·업로드는 403이다 [ASVS v5.0.0-3.5.1]', async () => {
    const reg = await ops.register({ requestId: randomUUID(), name: `동문-02-${RUN}`, promoterId: PROMOTER, actedBy: OPERATOR });
    const key = await keyOf();
    const wrong = await enroll(key, reg.enrollmentCode!, { origin: DEFAULT_PWA });
    expect(wrong.status).toBe(403);
    expect(problemType(wrong)).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    const none = await enroll(key, reg.enrollmentCode!, { origin: null });
    expect(none.status).toBe(403);
    // 코드는 소모되지 않았다
    expect((await enroll(key, reg.enrollmentCode!)).status).toBe(201);

    await place(reg.device.deviceId);
    const before = await scanRows();
    const path = '/v1/scanner/scans';
    const up = await call('POST', path, { dpop: await proofOf(key, { htm: 'POST', path }), origin: DEFAULT_PWA, 'content-type': 'application/json' }, [scan(randomUUID())]);
    expect(up.status).toBe(403);
    expect(problemType(up)).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    expect(await scanRows()).toBe(before);
  });

  test('O-T37 ② 같은 증명(jti)을 다시 보낸 업로드는 401이고 기록이 저장되지 않으며 지표 reason="jti"가 1 오른다 [ASVS v5.0.0-16.3.4]', async () => {
    const { deviceId, key } = await enrolledDevice('동문-03');
    await place(deviceId);
    const s = session(randomUUID());
    const proof = await proofOf(key, { htm: 'POST', path: '/v1/scanner/scans', ath: ATH });
    const jtiBefore = await rejections('jti');
    const rows0 = await scanRows();
    expect((await uploadWithToken(key, s, { proof })).status).toBe(200);
    expect(await scanRows()).toBe(rows0 + 1);
    const again = await uploadWithToken(key, s, { proof });
    expect(again.status).toBe(401);
    expect(again.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(await scanRows()).toBe(rows0 + 1);
    expect(await rejections('jti')).toBe(jtiBefore + 1);
  });

  test('O-T37 ③ htm만 다른 증명과 htu만 다른 증명의 업로드는 각각 401이고 기록이 저장되지 않는다', async () => {
    const { deviceId, key } = await enrolledDevice('동문-04');
    await place(deviceId);
    const s = session(randomUUID());
    const rows0 = await scanRows();
    const [htm0, htu0] = [await rejections('htm'), await rejections('htu')];
    const m = await uploadWithToken(key, s, { htm: 'PUT' });
    const u = await uploadWithToken(key, s, { htu: `https://${API_HOST}/v1/scanner/shift` });
    expect([m.status, u.status]).toEqual([401, 401]);
    expect([m.headers['www-authenticate'], u.headers['www-authenticate']]).toEqual(['DPoP error="invalid_dpop_proof"', 'DPoP error="invalid_dpop_proof"']);
    expect(await scanRows()).toBe(rows0);
    expect([await rejections('htm'), await rejections('htu')]).toEqual([htm0 + 1, htu0 + 1]);
  });

  test('O-T37 ④ iat가 서버 시각과 6분 어긋난 증명(앞·뒤)의 업로드는 401이고 기록이 저장되지 않는다', async () => {
    const { deviceId, key } = await enrolledDevice('동문-05');
    await place(deviceId);
    const s = session(randomUUID());
    const rows0 = await scanRows();
    const iat0 = await rejections('iat');
    const now = Math.floor(Date.now() / 1000);
    const past = await uploadWithToken(key, s, { iatSec: now - 360 });
    const future = await uploadWithToken(key, s, { iatSec: now + 360 });
    expect([past.status, future.status]).toEqual([401, 401]);
    expect(await scanRows()).toBe(rows0);
    expect(await rejections('iat')).toBe(iat0 + 2);
  });

  test('O-T37 ⑤ 기기 A의 토큰(cnf.jkt = A)을 기기 B 키 증명(ath 맞춤)과 보낸 업로드는 401이고 기록이 저장되지 않는다 [ASVS v5.0.0-10.3.5]', async () => {
    const a = await enrolledDevice('동문-06A');
    const b = await enrolledDevice('동문-06B');
    await place(a.deviceId);
    await place(b.deviceId);
    const s = session(randomUUID());
    const rows0 = await scanRows();
    const cnf0 = await rejections('cnf');
    const r = await uploadWithToken(b.key, s, { jkt: a.key.jkt });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(await scanRows()).toBe(rows0);
    expect(await rejections('cnf')).toBe(cnf0 + 1);
  });

  test('O-T37 ⑥ 등록하지 않은 키의 증명으로 올리면 403 device-unregistered이고 기록이 저장되지 않는다', async () => {
    const stranger = await keyOf();
    const rows0 = await scanRows();
    const n0 = await rejections('device_unregistered');
    const r = await uploadDeviceOnly(stranger, [scan(randomUUID())]);
    expect(r.status).toBe(403);
    expect(problemType(r)).toBe('https://peaket.example/problems/device-unregistered');
    expect(await scanRows()).toBe(rows0);
    expect(await rejections('device_unregistered')).toBe(n0 + 1);
  });

  test('O-T37 ⑧ 같은 키로 만든 새 증명 셋의 기기 인증만 업로드는 모두 200이고 기록이 셋 저장된다', async () => {
    const { deviceId, key } = await enrolledDevice('동문-07');
    await place(deviceId);
    const rows0 = await scanRows();
    const s = randomUUID();
    const accepted: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const one = scan(s);
      const r = await uploadDeviceOnly(key, [one]);
      expect(r.status, `업로드 ${i + 1}`).toBe(200);
      accepted.push(...((r.body.acceptedIds as unknown[]) ?? []));
      expect(r.body.acceptedIds).toEqual([one.id]);
    }
    expect(accepted).toHaveLength(3);
    expect(await scanRows()).toBe(rows0 + 3);
  });

  test('O-T21 ① 해제된 세션(identity가 무효로 답함)의 토큰은 근무 준비·목록·변경분·이상 표시·배치·업로드 모두 401 invalid_token이고 기록이 저장되지 않는다 [ASVS v5.0.0-7.2.1]', async () => {
    const { deviceId, key } = await enrolledDevice('동문-08');
    await place(deviceId);
    const released = session(randomUUID(), 'STAFF_ROLE_GATE_LEAD', false);
    const rows0 = await scanRows();
    const session0 = await rejections('session');
    const reads = ['/v1/scanner/shift', `/v1/scanner/events/${EVENT}/package`, `/v1/scanner/events/${EVENT}/changes?after=0`, `/v1/scanner/events/${EVENT}/flags`];
    for (const path of reads) {
      const r = await call('GET', path, await staffHeaders(key, 'GET', path, released));
      expect(r.status, path).toBe(401);
      expect(r.headers['www-authenticate'], path).toBe('DPoP error="invalid_token"');
    }
    const placementPath = `/v1/scanner/events/${EVENT}/device-placements/${deviceId}`;
    const put = await call('PUT', placementPath, { ...(await staffHeaders(key, 'PUT', placementPath, released)), 'content-type': 'application/json', 'if-match': '"1"' }, { gateZone: '서문', mode: 'IN' });
    expect(put.status).toBe(401);
    const resolutionPath = `/v1/scanner/flags/${randomUUID()}/resolution`;
    const resolve = await call('POST', resolutionPath, { ...(await staffHeaders(key, 'POST', resolutionPath, released)), 'content-type': 'application/json' }, { status: 'OK', note: '시험' });
    expect(resolve.status).toBe(401);
    const up = await uploadWithToken(key, released);
    expect(up.status).toBe(401);
    expect(up.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
    expect(await scanRows()).toBe(rows0);
    expect(await rejections('session')).toBe(session0 + 7);
  });

  test('O-T21 ② 같은 묶음을 토큰 없이 기기 인증만으로 다시 보내면 받고, 해제된 세션의 기록은 세션 밖 기록(OUT_OF_SESSION)으로 표시된다', async () => {
    const { deviceId, key } = await enrolledDevice('동문-09');
    await place(deviceId);
    const released = session(randomUUID(), 'STAFF_ROLE_GATE_STAFF', false);
    const batch = [scan(released), scan(released)];
    const rows0 = await scanRows();
    const withToken = await call('POST', '/v1/scanner/scans', { ...(await staffHeaders(key, 'POST', '/v1/scanner/scans', released)), 'content-type': 'application/json' }, batch);
    expect(withToken.status).toBe(401);
    expect(await scanRows()).toBe(rows0);
    const deviceOnly = await uploadDeviceOnly(key, batch);
    expect(deviceOnly.status).toBe(200);
    expect(deviceOnly.body.acceptedIds).toEqual(batch.map((b) => b.id));
    const flags = (deviceOnly.body.flags as { kind: string }[]).map((f) => f.kind);
    expect(flags.filter((k) => k === 'OUT_OF_SESSION')).toHaveLength(2);
    expect(await scanRows()).toBe(rows0 + 2);
  });

  test('O-T37 ⑦ ops-svc gRPC로 폐기하면 identity 세션 종료가 실패해도 그 기기의 다음 업로드는 403 device-revoked이고 기록이 저장되지 않는다', async () => {
    const { deviceId, key } = await enrolledDevice('동문-10');
    await place(deviceId);
    identity.terminateFails = true;
    const calls0 = identity.terminates.length;
    try {
      const revoked = await ops.revoke({ requestId: randomUUID(), deviceId, reason: '분실', actedBy: OPERATOR });
      expect(revoked.device).toMatchObject({ deviceId, status: 'REVOKED' });
    } finally {
      identity.terminateFails = false;
    }
    // 장애 주입이 실제로 닿았다(대역이 종료 요청을 받고 실패로 답했다)
    expect(identity.terminates.slice(calls0)).toEqual([{ device_id: deviceId, reason: 'DEVICE_REVOKED' }]);
    const rows0 = await scanRows();
    const n0 = await rejections('device_revoked');
    const r = await uploadDeviceOnly(key, [scan(randomUUID())]);
    expect(r.status).toBe(403);
    expect(problemType(r)).toBe('https://peaket.example/problems/device-revoked');
    const s = session(randomUUID());
    const t = await uploadWithToken(key, s);
    expect(t.status).toBe(403);
    expect(problemType(t)).toBe('https://peaket.example/problems/device-revoked');
    expect(await scanRows()).toBe(rows0);
    expect(await rejections('device_revoked')).toBe(n0 + 2);
  });
});

describe('O-T42 ⑤ 실제 ticket-svc(start): 키 묶기 저장의 일시 오류 뒤 등록 코드 되살림(실제 PostgreSQL 장애 주입·Valkey)', () => {
  const arm = async (deviceId: string) => {
    await database.pool.query('insert into f055_fault_target (device_id) values ($1) on conflict do nothing', [deviceId]);
    await database.pool.query('alter sequence f055_fault_seq restart with 1');
  };

  test('O-T42 ⑤ 첫 요청은 503 scanner-auth-unavailable(Retry-After 1)이고 코드 키는 처음 만료를 넘지 않게 되살아나며, 재시도는 201이고 일시 오류는 IP 실패로 세지 않는다', async () => {
    const reg = await ops.register({ requestId: randomUUID(), name: `동문-11-${RUN}`, promoterId: PROMOTER, actedBy: OPERATOR });
    const hash = enrollmentCodeHash(reg.enrollmentCode!);
    const codeKey = `scanner:enroll:${hash}`;
    const deviceKey = `scanner:enroll-device:${reg.device.deviceId}`;
    const ttlAtIssue = await pttl(codeKey);
    expect(ttlAtIssue).toBeGreaterThan(590_000);
    expect(ttlAtIssue).toBeLessThanOrEqual(600_000);
    await arm(reg.device.deviceId);
    const ip = '10.77.0.1';
    const key = await keyOf();

    const first = await enroll(key, reg.enrollmentCode!, { ip });
    expect(first.status).toBe(503);
    expect(problemType(first)).toBe('https://peaket.example/problems/scanner-auth-unavailable');
    expect(first.headers['retry-after']).toBe('1');
    // 장애가 실제로 일어났다(시퀀스가 소비됐다), 키는 묶이지 않았다
    expect(Number((await database.pool.query("select last_value from f055_fault_seq")).rows[0].last_value)).toBe(1);
    expect((await database.pool.query('select credential_thumbprint from scanner_device where id = $1', [reg.device.deviceId])).rows[0].credential_thumbprint).toBeNull();
    // 되살린 코드: 두 키가 다시 있고, 남은 수명은 발급 때보다 길지 않다
    const ttlRestored = await pttl(codeKey);
    expect(ttlRestored).toBeGreaterThan(0);
    expect(ttlRestored).toBeLessThanOrEqual(ttlAtIssue);
    expect(await redis.command(['GET', codeKey], { key: codeKey })).toBe(reg.device.deviceId);
    expect(await redis.command(['GET', deviceKey], { key: deviceKey })).toBe(hash);
    expect(await pttl(deviceKey)).toBeLessThanOrEqual(ttlAtIssue);

    const retry = await enroll(key, reg.enrollmentCode!, { ip });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ deviceId: reg.device.deviceId });
    expect(await pttl(codeKey)).toBe(-2);

    // 503은 실패로 세지 않았다: 같은 IP에서 틀린 코드 10번까지 410이고 11번째가 429다
    const other = await keyOf();
    for (let i = 0; i < 10; i++) expect((await enroll(other, 'BCDF-GHJK-LMNP', { ip })).status, `실패 ${i + 1}번째`).toBe(410);
    expect((await enroll(other, 'BCDF-GHJK-LMNP', { ip })).status).toBe(429);
  });

  test('O-T42 ⑤ 실패 뒤 운영자가 새 코드를 발급하면 옛 코드는 410이고 새 코드만 201이다', async () => {
    const reg = await ops.register({ requestId: randomUUID(), name: `동문-12-${RUN}`, promoterId: PROMOTER, actedBy: OPERATOR });
    await arm(reg.device.deviceId);
    const ip = '10.78.0.1';
    const key = await keyOf();
    expect((await enroll(key, reg.enrollmentCode!, { ip })).status).toBe(503);
    const fresh = await ops.reissue({ requestId: randomUUID(), deviceId: reg.device.deviceId, actedBy: OPERATOR });
    expect(fresh.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    const old = await enroll(key, reg.enrollmentCode!, { ip });
    expect(old.status).toBe(410);
    expect(problemType(old)).toBe('https://peaket.example/problems/enrollment-code-expired');
    expect((await enroll(key, fresh.enrollmentCode!, { ip })).status).toBe(201);
  });
});

describe('판정에 닿지 못하면 닫는다(offline-gate §6.6, identity-svc 멈춤 장애 주입)', () => {
  test('O-T37 ⑨ identity 대역을 멈추면 캐시 없는 세션의 업로드는 1초 [가정] 한도 안에 503 scanner-auth-unavailable(Retry-After 1)이고 200이 없으며 기록이 저장되지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    const { deviceId, key } = await enrolledDevice('동문-13');
    await place(deviceId);
    const s = session(randomUUID());
    const unavailable0 = await rejections('unavailable');
    const rows0 = await scanRows();
    identity.server!.forceShutdown();
    // real-time: start()는 실제 시계와 실제 gRPC 마감(1초 [가정])을 쓴다. 가짜 시계로 대신할 수 없다 F-05-5
    const t0 = performance.now();
    const r = await uploadWithToken(key, s);
    const elapsed = performance.now() - t0;
    expect(r.status).toBe(503);
    expect(problemType(r)).toBe('https://peaket.example/problems/scanner-auth-unavailable');
    expect(r.headers['retry-after']).toBe('1');
    expect(elapsed).toBeLessThan(1_400);
    const again = await call('GET', '/v1/scanner/shift', await staffHeaders(key, 'GET', '/v1/scanner/shift', randomUUID()));
    expect(again.status).toBe(503);
    expect(await scanRows()).toBe(rows0);
    expect(await rejections('unavailable')).toBe(unavailable0 + 2);
  });
});
