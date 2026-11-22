// 화면에서 실제 identity-svc까지 잇는 연결 시험(docs/architecture.md §8.6 4의 4, docs/review/plans/F-05-7.md §8, docs/features/identity.md §12
// I-T90 ⑤·I-T91 ⑥·I-T92 ④·I-T93 ④, ADR-0362, BUILD_ORDER F-05-7 시험 담당). 가짜 API로 끝내지 않는다.
// 띄우는 것: 실제 PostgreSQL 18(0038까지)·실제 Valkey(기기 승인 요청·한도)·시작 파일 main.ts(실제 Drizzle·Redis 조립)·웹의 로컬 게이트웨이 대역
// (apps/web/scripts/local-fan-gateway.mjs). 화면 쪽은 웹 흐름 모듈(features/staff-invitation·staff-approval·device-sessions, _pages/staff-home/model/live,
// _pages/settings/model/devices)을 동적으로 가져와, 팬 액세스 쿠키를 실은 fetch로 게이트웨이 대역을 부른다(identity-svc tsconfig가 .ts 가져오기를 받지 않아 정적 import를 쓰지 않는다).
// 실제가 아닌 것: 회차 공개 요약 GET /v1/events/{eventId}는 core-svc 공개 데이터라 게이트웨이 대역의 fallbackUrl로 웹 가짜 API(apps/web/scripts/mock-api.mjs)가 답한다
// (씨앗 회차 ID는 가짜 API에 있는 회차). 기기 원장(ticket-svc gRPC)은 승인 요청을 만들 때만 대역이다. Kafka 발행은 Outbox 행까지 본다.
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { DrizzleStaffAssignmentStore } from '../src/modules/session/adapters/db/drizzle-staff-assignment-store.js';
import { RedisDeviceApprovalLimits, RedisDeviceAuthorizations } from '../src/modules/session/adapters/redis-device-authorizations.js';
import { CheckScannerSession } from '../src/modules/session/application/check-scanner-session.js';
import { StartDeviceAuthorization } from '../src/modules/session/application/start-device-authorization.js';
import type { ScannerDeviceLookupAnswer, ScannerDeviceRegistry } from '../src/modules/session/domain/ports.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, fanKey, ISSUER, newKey, noClaims, noClosure, recordingSignals, testAgency, testDeviceRefs } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const HOUR = 3_600_000;
const WEB = 'http://localhost:3000';
const web = (p: string) => new URL(`../../../apps/web/${p}`, import.meta.url).href;
const hash = (s: string) => Buffer.from(createHash('sha256').update(s, 'utf8').digest('hex'), 'hex');

// ---- 웹 흐름 모듈의 바깥 모양(계획 F-05-7 §5 '웹 흐름 모듈의 바깥 모양'. 화면이 쓰는 것만) ----
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EventSummaryReader = { read(eventId: string): Promise<{ kind: string; summary?: { title: string; sellerName: string; startsAt: string } }> };
interface InvitationModule {
  createStaffInvitationApi(o: { origin: string; fetch: FetchLike }): {
    accept(i: { inviteToken: string; consentVersion: string }): Promise<{ kind: string }>;
    reject(inviteToken: string): Promise<{ kind: string }>;
    listAssignments(cursor?: string | null): Promise<{ kind: string; items?: { assignmentId: string; eventId: string; status: string; validFrom: string; validUntil: string; activeScannerDeviceName: string | null; role: string }[] }>;
    lookup(token: string): Promise<{ kind: string }>;
  };
  loadInvitation(o: { api: unknown; events: EventSummaryReader; token: string | null }): Promise<{ state: string; invitation?: { eventId: string; consents: { consentVersion: string; collection: string; provision: string } }; summary?: { sellerName: string; title: string } }>;
  afterAccept(r: { kind: string }): string;
  afterReject(r: { kind: string }): string;
  canAcceptIn(l: unknown): boolean;
}
interface ApprovalModule {
  createStaffApprovalApi(o: { origin: string; fetch: FetchLike }): { decide(i: { userCode: string; decision: 'APPROVE' | 'DENY'; assignmentId?: string }): Promise<{ kind: string }> };
  loadApproval(o: { api: unknown; events: EventSummaryReader; code: string | null }): Promise<{ state: string; view?: { deviceName: string; code: string; partnerName: string | null; assignments: { assignmentId: string }[] } }>;
  afterDecide(r: { kind: string }, d: 'APPROVE' | 'DENY'): string;
}
interface DevicesModule {
  createDevicesApi(o: { origin: string; fetch: FetchLike }): {
    listScanner(): Promise<{ kind: string; items?: { sessionId: string; deviceName: string | null; eventId: string; role: string }[] }>;
    endScanner(sessionId: string, reauthToken: string): Promise<{ kind: string }>;
  };
}
interface SettingsDevicesModule {
  scannerSectionView(a: unknown): { rows: { id: string; name: string; tag?: string }[]; banner: string | null };
}
interface StaffHomeModule {
  staffHomeLiveView(items: readonly unknown[], summaries: ReadonlyMap<string, unknown>, nowMs: number): { current: { id: string; phaseLabel: string; scannerName: string | null; title: string | null }[]; past: { id: string; phaseLabel: string }[] };
}
interface EventSummaryModule {
  createEventSummaryReader(o: { origin: string; fetch: FetchLike }): EventSummaryReader;
  readEventSummaries(r: EventSummaryReader, ids: readonly string[]): Promise<Map<string, unknown>>;
}
interface MockApiModule {
  homeFeed(origin: string): { banners: { eventId: string }[] };
  eventDetail(origin: string, eventId: string): { sellerName: string; title: string } | undefined;
  startMockApi(o: { port: number }): Promise<{ address(): { port: number } | string | null; close(cb?: () => void): void }>;
}
interface GatewayModule {
  startLocalFanGateway(o: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }>;
}

let pg: PostgresContainer;
let vk: ValkeyContainer;
let database: Database;
let cache: HotRedis;
let signer: JoseTokenSigner;
let gw: Awaited<ReturnType<GatewayModule['startLocalFanGateway']>>;
let mock: Awaited<ReturnType<MockApiModule['startMockApi']>>;
let mgmtPort = 0;
let mods: { inv: InvitationModule; appr: ApprovalModule; dev: DevicesModule; settings: SettingsDevicesModule; home: StaffHomeModule; events: EventSummaryModule; mockApi: MockApiModule };

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

beforeAll(async () => {
  pg = await startPostgres();
  vk = await startValkey();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-staff-screens-wiring-test', max: 4 });
  await ensureOutboxPartitions(database, systemClock);
  cache = await createHotRedis({ url: vk.url });
  const fan = await fanKey();
  const httpPort = await freePort();
  mgmtPort = await freePort();
  for (const k of ['PEAKET_VERIFICATION_PROVIDER', 'PEAKET_TRUST_GRPC_URL', 'PEAKET_TELEMETRY_KAFKA_BROKERS', 'PEAKET_ADMIN_PEPPER_KMS_KEYS', 'PEAKET_ADMIN_PEPPER', 'PEAKET_PURCHASE_GRPC_URL', 'PEAKET_TICKET_GRPC_URL', 'PEAKET_CORE_HTTP_URL']) delete process.env[k];
  Object.assign(process.env, {
    PEAKET_ENV: 'ci',
    PEAKET_DATABASE_URL: pg.url,
    PEAKET_IDENTITY_REDIS_URL: vk.url,
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(await freePort()),
    PORT: String(httpPort),
    PEAKET_MANAGEMENT_PORT: String(mgmtPort),
    PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk),
    PEAKET_TOKEN_ISSUER: ISSUER,
    PEAKET_LOG_LEVEL: 'fatal',
  });
  signer = new JoseTokenSigner(await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) }), ISSUER);
  await import('../src/main.js');
  mods = {
    inv: (await import(/* @vite-ignore */ web('src/features/staff-invitation/index.ts'))) as InvitationModule,
    appr: (await import(/* @vite-ignore */ web('src/features/staff-approval/index.ts'))) as ApprovalModule,
    dev: (await import(/* @vite-ignore */ web('src/features/device-sessions/flow.ts'))) as DevicesModule,
    settings: (await import(/* @vite-ignore */ web('src/_pages/settings/model/devices.ts'))) as SettingsDevicesModule,
    home: (await import(/* @vite-ignore */ web('src/_pages/staff-home/model/live.ts'))) as StaffHomeModule,
    events: (await import(/* @vite-ignore */ web('src/entities/event-summary/index.ts'))) as EventSummaryModule,
    mockApi: (await import(/* @vite-ignore */ web('scripts/mock-api.mjs'))) as MockApiModule,
  };
  const gateway = (await import(/* @vite-ignore */ web('scripts/local-fan-gateway.mjs'))) as GatewayModule;
  mock = await mods.mockApi.startMockApi({ port: 0 });
  const mockAddr = mock.address();
  const mockPort = typeof mockAddr === 'object' && mockAddr ? mockAddr.port : 0;
  gw = await gateway.startLocalFanGateway({
    port: 0,
    identityUrl: `http://127.0.0.1:${httpPort}`,
    webOrigin: WEB,
    jwks: { keys: [fan.publicJwk] },
    issuer: ISSUER,
    env: { PEAKET_ENV: 'ci' },
    fallbackUrl: `http://127.0.0.1:${mockPort}`,
  });
  // 예열: 막 뜬 main.ts의 DB 풀은 첫 연결이 풀 대기 한도(1초)를 넘으면 429 server-busy로 답한다(docs/architecture.md §5, 시험 PC의 Docker 첫 연결).
  // 본 대본 전에 DB를 읽는 경로가 200을 줄 때까지(조건으로) 기다린다. 대본의 단언은 다시 시도하지 않는다
  const warm = await new CreateSession(new DrizzleSessionStore(database, systemClock), signer, testDeviceRefs(), recordingSignals(), noClaims, systemClock).run({
    idempotencyKey: newKey(),
    provider: 'kakao',
    providerUserId: `warm-${newKey().slice(0, 8)}`,
    email: null,
    deviceId: 'dev-warm',
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await fetch(`${gw.url}/v1/identity/scanner-sessions`, { headers: { cookie: `__Secure-peaket_at=${warm.accessToken}` } });
    await r.text();
    if (r.status === 200) break;
    if (r.status !== 429 || Date.now() > deadline) throw new Error(`예열이 끝나지 않았다: ${r.status}`);
  }
}, 180_000);

afterAll(async () => {
  await gw?.close();
  await new Promise<void>((r) => (mock ? mock.close(() => r()) : r()));
  await cache?.close().catch(() => {});
  await database?.close();
  pg?.stop();
  vk?.stop();
});

/** 브라우저처럼: 쿠키는 credentials가 omit이 아닐 때만, 쓰기에는 소비자 웹 Origin을 싣는다 */
const browserFetch =
  (accessToken: string): FetchLike =>
  (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.credentials !== 'omit') headers.set('cookie', `__Secure-peaket_at=${accessToken}`);
    if ((init.method ?? 'GET') !== 'GET') headers.set('origin', WEB);
    const { credentials: _c, cache: _k, ...rest } = init;
    void _c;
    void _k;
    return fetch(input, { ...rest, headers });
  };

class LedgerDouble implements ScannerDeviceRegistry {
  constructor(private readonly answer: ScannerDeviceLookupAnswer) {}
  async byThumbprint(): Promise<ScannerDeviceLookupAnswer> {
    return this.answer;
  }
}

test('I-T91 ⑥ I-T92 ④ I-T93 ④ I-T90 ⑤ 화면 흐름 모듈로 실제 identity-svc의 초대를 조회·수락·거절하고, 스캐너를 승인한 뒤 계정 설정에서 끝내면 스캐너 세션 확인이 거절한다', async () => {
  const now = Date.now();
  const origin = 'http://mock.test';
  const [E1, E2, E3] = mods.mockApi.homeFeed(origin).banners.map((b) => b.eventId) as [string, string, string];
  const seller = mods.mockApi.eventDetail(origin, E1)!.sellerName;
  const PROMOTER = randomUUID();
  const EMAIL = 'f057.wiring@example.org';

  // 씨앗: 검증된 구글 이메일 계정 + 휴대폰 본인확인 기록
  const sessions = new DrizzleSessionStore(database, systemClock);
  const create = new CreateSession(sessions, signer, testDeviceRefs(), recordingSignals(), noClaims, systemClock);
  const me = await create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: `g-${newKey().slice(0, 10)}`, email: EMAIL, emailVerified: true, deviceId: 'dev-phone' });
  const vclock = fakeClock({ now });
  const vstore = new DrizzleVerificationStore(database);
  const agency = testAgency(vclock);
  const started = await new StartVerification(vstore, agency, noClosure, vclock).run({ accountId: me.accountId, sessionId: me.sessionId, purpose: 'FIRST', next: '/staff/invitations' });
  await new ConfirmVerification(vstore, agency, HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)), noClosure, vclock).run({
    accountId: me.accountId,
    verificationId: started.verificationId,
    providerResult: agencyResult(vclock, started.verificationId, { person: 'f057-person' }),
  });
  // 씨앗: 초대 둘(토큰 해시만 DB에), 해제할 배정 하나
  const [A1, A2, A3] = [randomUUID(), randomUUID(), randomUUID()];
  const T1 = `inv-${newKey()}`;
  const T2 = `inv-${newKey()}`;
  const invite = (id: string, eventId: string, token: string) =>
    database.pool.query(
      `insert into staff_assignment (id, account_id, event_id, role, invite_email, invite_token_hash, invite_expires_at, invited_by, valid_from, valid_until, status, promoter_id)
       values ($1, null, $2, 'gate_lead', $3, $4, $5, $6, $7, $8, 'INVITED', $9)`,
      [id, eventId, EMAIL, hash(token), new Date(now + HOUR), randomUUID(), new Date(now - HOUR), new Date(now + 6 * HOUR), PROMOTER],
    );
  await invite(A1, E1, T1);
  await invite(A2, E2, T2);
  await database.pool.query(
    // 수락한 배정: invite_expires_at은 NOT NULL이라 초대 때의 만료를 남긴다(0031, docs/data.md staff_assignment)
    `insert into staff_assignment (id, account_id, event_id, role, invite_expires_at, invited_by, valid_from, valid_until, status, promoter_id, accepted_at, consent_version)
     values ($1, $2, $3, 'gate_staff', $4, $5, $6, $7, 'ASSIGNED', $8, $9, 'staff-2026-11-23')`,
    [A3, me.accountId, E3, new Date(now + HOUR), randomUUID(), new Date(now - HOUR), new Date(now + 6 * HOUR), PROMOTER, new Date(now - HOUR)],
  );
  const staffDb = new DrizzleStaffAssignmentStore(database, systemClock);

  const f = browserFetch(me.accessToken);
  const api = mods.inv.createStaffInvitationApi({ origin: gw.url, fetch: f });
  const events = mods.events.createEventSummaryReader({ origin: gw.url, fetch: f });

  // I-T91 ⑥ 조회 → 수락 → 내 배정 ASSIGNED
  const load = await mods.inv.loadInvitation({ api, events, token: T1 });
  expect(load.state).toBe('동의 전');
  expect(load.invitation?.eventId).toBe(E1);
  expect(load.summary?.sellerName).toBe(seller);
  expect(load.invitation?.consents.consentVersion).toBe('staff-2026-11-23');
  expect(mods.inv.canAcceptIn(load)).toBe(true);
  expect(mods.inv.afterAccept(await api.accept({ inviteToken: T1, consentVersion: load.invitation!.consents.consentVersion }))).toBe('수락 완료');
  const afterAccept = await api.listAssignments();
  expect(afterAccept.kind).toBe('ok');
  expect(afterAccept.items?.find((x) => x.assignmentId === A1)).toMatchObject({ eventId: E1, status: 'ASSIGNED' });

  // I-T91 ⑥ 다른 초대 거절 → EXPIRED, 초대 이메일·토큰 해시가 비었다
  expect(mods.inv.afterReject(await api.reject(T2))).toBe('거절함');
  expect((await database.pool.query('select status, invite_email, invite_token_hash from staff_assignment where id = $1', [A2])).rows[0]).toEqual({ status: 'EXPIRED', invite_email: null, invite_token_hash: null });
  // 같은 링크를 다시 열면 만료다
  expect((await mods.inv.loadInvitation({ api, events, token: T2 })).state).toBe('만료');

  // 파트너가 A3를 해제한다(해제 경로는 파트너 콘솔 몫이라 저장소로 부른다)
  expect(await staffDb.revokeAssignment({ assignmentId: A3, nowMs: Date.now() })).toMatchObject({ found: true, changed: true });

  // I-T92 ④ 기기 승인 요청(Valkey, 실제 저장소 어댑터) → 화면 흐름 모듈로 조회·승인 → 스캐너 세션 하나, device_name이 기기 이름
  const DEVICE = randomUUID();
  const DEVICE_NAME = '서문-14';
  const start = new StartDeviceAuthorization(new LedgerDouble({ found: true, deviceId: DEVICE, status: 'ACTIVE', name: DEVICE_NAME, promoterId: PROMOTER }), new RedisDeviceAuthorizations(cache, () => systemClock.now()), new RedisDeviceApprovalLimits(cache), systemClock);
  process.env.PEAKET_SCANNER_APPROVAL_URL = 'https://scanner.peaket.test/staff/approve';
  const code = (await start.run({ jkt: 'B'.repeat(43) })).userCode;
  const appr = mods.appr.createStaffApprovalApi({ origin: gw.url, fetch: f });
  const lookup = await mods.appr.loadApproval({ api: appr, events, code });
  expect(lookup.state).toBe('승인 대기');
  expect(lookup.view).toMatchObject({ deviceName: DEVICE_NAME, code, partnerName: seller });
  expect(lookup.view?.assignments.map((x) => x.assignmentId)).toEqual([A1]);
  expect(mods.appr.afterDecide(await appr.decide({ userCode: code, decision: 'APPROVE', assignmentId: A1 }), 'APPROVE')).toBe('승인됨');
  const ss = (await database.pool.query<{ id: string; device_name: string | null; scanner_device_id: string }>('select id, device_name, scanner_device_id from scanner_session where staff_account_id = $1', [me.accountId])).rows;
  expect(ss.map((r) => [r.device_name, r.scanner_device_id])).toEqual([[DEVICE_NAME, DEVICE]]);
  const scannerSessionId = ss[0]!.id;

  // I-T93 ④ 내 배정 목록: 수락한 배정은 진행 중·지금 로그인한 스캐너, 해제한 배정은 해제
  const list = await api.listAssignments();
  const summaries = await mods.events.readEventSummaries(events, (list.items ?? []).map((x) => x.eventId));
  const view = mods.home.staffHomeLiveView(list.items ?? [], summaries, Date.now());
  const byId = new Map([...view.current, ...view.past].map((c) => [c.id, c]));
  expect(byId.get(A1)).toMatchObject({ phaseLabel: '진행 중', scannerName: DEVICE_NAME, title: mods.mockApi.eventDetail(origin, E1)!.title });
  expect(byId.get(A3)).toMatchObject({ phaseLabel: '해제' });
  expect(byId.has(A2)).toBe(false);

  // I-T90 ⑤ 계정 설정: 스캐너 세션 목록 한 줄 → 재인증 토큰으로 끝내기 → 스캐너 세션 확인 거절
  const check = new CheckScannerSession(staffDb, systemClock);
  expect((await check.run({ scannerSessionId, deviceId: DEVICE })).valid).toBe(true);
  const devices = mods.dev.createDevicesApi({ origin: gw.url, fetch: f });
  const scanners = await devices.listScanner();
  expect(scanners).toMatchObject({ kind: 'ok', items: [{ sessionId: scannerSessionId, deviceName: DEVICE_NAME, eventId: E1, role: 'gate_lead' }] });
  const section = mods.settings.scannerSectionView(scanners);
  expect(section.rows).toEqual([{ id: scannerSessionId, name: `현장 스캐너 ${DEVICE_NAME}`, icon: 'scan', tag: '스태프 세션' }]);
  expect(section.banner).toBe('휴대폰에서 로그아웃해도 스캐너 세션은 따로 끝내야 합니다');
  // 받는 쪽 작업이 다른 토큰(SESSION_END)은 거절되고 세션은 그대로다
  const wrongOp = (await signer.reauth({ accountId: me.accountId, sessionId: me.sessionId, provider: 'google', strength: 'verified', operation: 'SESSION_END' }, Date.now())).token;
  expect(await devices.endScanner(scannerSessionId, wrongOp)).toEqual({ kind: 'reauth' });
  expect((await check.run({ scannerSessionId, deviceId: DEVICE })).valid).toBe(true);
  const reauth = (await signer.reauth({ accountId: me.accountId, sessionId: me.sessionId, provider: 'google', strength: 'verified', operation: 'SCANNER_SESSION_END' }, Date.now())).token;
  expect(await devices.endScanner(scannerSessionId, reauth)).toEqual({ kind: 'done' });
  expect((await check.run({ scannerSessionId, deviceId: DEVICE })).valid).toBe(false);
  expect(await devices.listScanner()).toEqual({ kind: 'ok', items: [] });
  // 같은 트랜잭션의 세션 종료 사건(사유 LOGOUT, 키 계정 ID)
  const outbox = await database.pool.query<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1 order by seq", [me.accountId]);
  expect(outbox.rows.map((r) => JSON.parse(r.payload.toString()) as { sessionId: string; reason: string }).filter((v) => v.sessionId === scannerSessionId).map((v) => v.reason)).toEqual(['LOGOUT']);
  // 다시 보내면 이미 끝난 세션(404 session-not-found)
  const reauth2 = (await signer.reauth({ accountId: me.accountId, sessionId: me.sessionId, provider: 'google', strength: 'verified', operation: 'SCANNER_SESSION_END' }, Date.now())).token;
  expect(await devices.endScanner(scannerSessionId, reauth2)).toEqual({ kind: 'gone' });
  // 시작 파일(main.ts)의 조립이 지표를 단다: 이 시험의 끝내기 한 건(404는 세지 않는다)이 /metrics에 보인다. 다른 시험의 차례에 기대지 않게 여기서 본다
  const metrics = await (await fetch(`http://127.0.0.1:${mgmtPort}/metrics`)).text();
  expect(metrics).toMatch(/identity_scanner_session_ended_total\{[^}]*cause="self"[^}]*\} 1\b/);
}, 120_000);

test('identity-svc 시작 파일이 스캐너 세션 두 경로를 조립한다: 신원 없는 두 경로는 401이다(경로가 없으면 404)', async () => {
  expect((await fetch(`${gw.url}/v1/identity/scanner-sessions`)).status).toBe(401);
  expect((await fetch(`${gw.url}/v1/identity/scanner-sessions/${randomUUID()}`, { method: 'DELETE', headers: { origin: WEB } })).status).toBe(401);
});

// 브라우저 확인용(계획 F-05-7 §8·§11): PEAKET_LOCAL_STACK=1이면 위 스택(실제 PostgreSQL·Valkey·main.ts·게이트웨이 대역·가짜 API)을 띄운 채 두고
// 새 씨앗(초대 하나·승인 코드 하나)의 링크와 팬 액세스 쿠키를 찍는다. 평소에는 돌지 않는다. 멈추기: PEAKET_LOCAL_STOP 파일(기본 <tmp>/peaket-lane3-f057-stack.stop)을 만든다.
//   PEAKET_LOCAL_STACK=1 node node_modules/vitest/vitest.mjs run --config vitest.integration.config.mjs test-int/staff-screens-wiring.int.test.ts
// 끝나면 afterAll이 컨테이너를 docker rm -f -v로 지운다.
test.runIf(process.env.PEAKET_LOCAL_STACK === '1')('브라우저 확인용 스택을 멈춤 파일이 생길 때까지 띄워 둔다', async () => {
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const stop = process.env.PEAKET_LOCAL_STOP ?? join(tmpdir(), 'peaket-lane3-f057-stack.stop');
  const now = Date.now();
  const origin = 'http://mock.test';
  const banners = mods.mockApi.homeFeed(origin).banners.map((b) => b.eventId);
  const eventId = banners[banners.length - 1]!;
  const PROMOTER = randomUUID();
  const EMAIL = `f057.browser.${newKey().slice(0, 6).toLowerCase()}@example.org`;
  const create = new CreateSession(new DrizzleSessionStore(database, systemClock), signer, testDeviceRefs(), recordingSignals(), noClaims, systemClock);
  const me = await create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: `g-${newKey().slice(0, 10)}`, email: EMAIL, emailVerified: true, deviceId: 'dev-browser' });
  const token = `inv-${newKey()}`;
  await database.pool.query(
    `insert into staff_assignment (id, account_id, event_id, role, invite_email, invite_token_hash, invite_expires_at, invited_by, valid_from, valid_until, status, promoter_id)
     values ($1, null, $2, 'gate_lead', $3, $4, $5, $6, $7, $8, 'INVITED', $9)`,
    [randomUUID(), eventId, EMAIL, hash(token), new Date(now + 24 * HOUR), randomUUID(), new Date(now - HOUR), new Date(now + 6 * HOUR), PROMOTER],
  );
  const start = new StartDeviceAuthorization(new LedgerDouble({ found: true, deviceId: randomUUID(), status: 'ACTIVE', name: '동문-03', promoterId: PROMOTER }), new RedisDeviceAuthorizations(cache, () => systemClock.now()), new RedisDeviceApprovalLimits(cache), systemClock);
  const code = (await start.run({ jkt: 'C'.repeat(43) })).userCode;
  console.log(
    [
      `게이트웨이 대역(NEXT_PUBLIC_API_ORIGIN): ${gw.url}`,
      `초대 링크: ${WEB}/staff/invitations#token=${token}`,
      `승인 링크(5분): ${WEB}/staff/approve#code=${code}`,
      `팬 액세스 쿠키 __Secure-peaket_at(15분, 시험 계정 ${EMAIL}): ${me.accessToken}`,
      `멈추기: ${stop} 파일을 만든다`,
    ].join('\n'),
  );
  // fixed-wait: 사람이 브라우저로 확인하는 동안 스택을 띄워 두는 대기(단언이 아니다, 멈춤 파일을 1초마다 본다) F-05-7
  while (!existsSync(stop)) await new Promise((r) => setTimeout(r, 1_000));
}, 6 * HOUR);
