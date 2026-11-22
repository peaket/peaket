// 내 스캐너 세션 조회·끝내기의 HTTP 답(GET /v1/identity/scanner-sessions, DELETE /v1/identity/scanner-sessions/{sessionId}, docs/features/identity.md §6.1
// '휴대폰 화면 실제 연결' ④, §12 I-T89 ①~⑤, ADR-0362 결정 6, BUILD_ORDER F-05-7 시험 담당). 메모리 조립(AppModule memory)과 http.inject로 본다.
// PostgreSQL(같은 트랜잭션의 Outbox 행·0038)은 test-int/scanner-sessions-self.int.test.ts.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { CheckScannerSession, CreateSession, JoseTokenSigner, STAFF_ASSIGNMENT_STORE, TokenKeyRing } from '../src/modules/session/index.js';
import type { ReauthOperation } from '../src/modules/session/domain/session.js';
import { fanKey, ISSUER, newKey, recordingSignals, testDeviceRefs } from './support.js';

const HOUR = 3_600_000;
const URL_BASE = '/v1/identity/scanner-sessions';
let svc: Awaited<ReturnType<typeof createService>>;
let signer: JoseTokenSigner;
let staff: MemoryStaffAssignmentStore;
const clock = fakeClock({ now: Date.parse('2026-11-23T05:12:30.250Z') });

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  signer = new JoseTokenSigner(keys, ISSUER);
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({ memory: true, session: { signer, keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' } } as never),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  staff = svc.app.get<MemoryStaffAssignmentStore>(STAFF_ASSIGNMENT_STORE);
});
afterAll(async () => {
  await svc?.close();
});

type Fan = { accountId: string; sessionId: string };
let seq = 0;
const login = (sub: string, deviceId = 'dev-phone') =>
  svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: null, emailVerified: false, deviceId });
const fanHeaders = (s: Fan) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
const reauth = async (s: Fan, operation: ReauthOperation) => (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', operation }, svc.clock.now())).token;
const list = (s: Fan) => svc.http.inject({ method: 'GET', url: URL_BASE, headers: fanHeaders(s) });
const end = (s: Fan, id: string, token?: string) =>
  svc.http.inject({ method: 'DELETE', url: `${URL_BASE}/${id}`, headers: { ...fanHeaders(s), ...(token === undefined ? {} : { 'x-reauth-token': token }) } });
const problem = (r: { body: string }) => JSON.parse(r.body) as { type: string; status: number; title: string };
const uuid = (n: number) => `0190f3a1-7c2e-7a00-8000-${n.toString(16).padStart(12, '0')}`;

/** 그 계정에 배정 하나와 스캐너 세션 하나를 둔다(기기 승인이 만드는 것과 같은 저장소 포트 createScannerSession). 기기 이름은 코드 상수와 다른 값 */
async function seedScanner(s: Fan, o: { deviceName?: string | null; expiresInMs?: number; role?: 'gate_staff' | 'gate_lead'; proxy?: boolean } = {}) {
  const n = ++seq;
  const assignmentId = uuid(0x9000 + n);
  const eventId = uuid(0xe000 + n);
  const scannerSessionId = uuid(0x5000 + n);
  const now = svc.clock.now();
  staff.assignments.set(assignmentId, {
    id: assignmentId,
    accountId: s.accountId,
    status: 'ASSIGNED',
    eventId,
    role: o.role ?? 'gate_lead',
    promoterId: uuid(0xb000 + n),
    invitedBy: uuid(0xa000 + n),
    validFromMs: now - HOUR,
    validUntilMs: now + 6 * HOUR,
  });
  await staff.createScannerSession({
    scannerSessionId,
    assignmentId,
    deviceId: uuid(0xd000 + n),
    accountId: s.accountId,
    approvedBySession: s.sessionId,
    role: o.role ?? 'gate_lead',
    proxy: o.proxy ?? false,
    approvedAtMs: now,
    expiresAtMs: now + (o.expiresInMs ?? 6 * HOUR),
    ...(o.deviceName === undefined ? {} : { deviceName: o.deviceName }),
  });
  return { scannerSessionId, eventId, assignmentId, deviceId: uuid(0xd000 + n), approvedAtMs: now, expiresAtMs: now + (o.expiresInMs ?? 6 * HOUR) };
}
const terminatedAt = (id: string) => staff.sessions.get(id)?.terminatedAt;

describe('GET /v1/identity/scanner-sessions(I-T89 ①②)', () => {
  test('I-T89 ① 스캐너 세션이 없는 계정(스태프가 아닌 계정)은 200 빈 items이고 no-store다', async () => {
    const s = await login('scn-none');
    const r = await list(s);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ items: [] });
  });

  test('I-T89 ① 살아 있는 세션 한 줄의 여덟 칸이 저장한 값과 같고 스태프 토큰·기기 키·기기 ID는 없다', async () => {
    const s = await login('scn-one');
    const seeded = await seedScanner(s, { deviceName: '서문-11', role: 'gate_staff', proxy: true });
    const seen = svc.clock.now() + 90_000;
    await staff.touchScannerSession(seeded.scannerSessionId, seen);
    const r = await list(s);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    // toEqual이라 칸이 하나라도 더 있으면(deviceId·jkt·staffToken 등) 실패한다
    expect(JSON.parse(r.body)).toEqual({
      items: [
        {
          sessionId: seeded.scannerSessionId,
          deviceName: '서문-11',
          eventId: seeded.eventId,
          role: 'gate_staff',
          proxy: true,
          approvedAt: new Date(seeded.approvedAtMs).toISOString(),
          expiresAt: new Date(seeded.expiresAtMs).toISOString(),
          lastSeenAt: new Date(seen).toISOString(),
        },
      ],
    });
    expect(r.body).not.toContain(seeded.deviceId);
  });

  test('I-T89 ① 이름 없이 만든 옛 세션(0038 전)의 deviceName은 null이고 마지막 연락 전이면 lastSeenAt도 null이다', async () => {
    const s = await login('scn-legacy');
    const seeded = await seedScanner(s);
    const body = JSON.parse((await list(s)).body) as { items: { deviceName: unknown; lastSeenAt: unknown; sessionId: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ sessionId: seeded.scannerSessionId, deviceName: null, lastSeenAt: null });
  });

  test('I-T89 ② expires_at 1ms 전은 남고 정각이면 빠진다', async () => {
    const s = await login('scn-edge');
    const seeded = await seedScanner(s, { deviceName: '북문-07', expiresInMs: 1 });
    const before = JSON.parse((await list(s)).body) as { items: { sessionId: string }[] };
    expect(before.items.map((x) => x.sessionId)).toEqual([seeded.scannerSessionId]);
    clock.advance(1);
    expect(svc.clock.now()).toBe(seeded.expiresAtMs);
    expect(JSON.parse((await list(s)).body)).toEqual({ items: [] });
  });

  test('I-T89 ② 끝난 세션과 다른 계정의 세션은 목록에 없다', async () => {
    const a = await login('scn-ended');
    const b = await login('scn-other');
    const ended = await seedScanner(a, { deviceName: '남문-02' });
    staff.sessions.set(ended.scannerSessionId, { ...staff.sessions.get(ended.scannerSessionId)!, terminatedAt: svc.clock.now() });
    const others = await seedScanner(b, { deviceName: '남문-03' });
    expect(JSON.parse((await list(a)).body)).toEqual({ items: [] });
    const mine = JSON.parse((await list(b)).body) as { items: { sessionId: string }[] };
    expect(mine.items.map((x) => x.sessionId)).toEqual([others.scannerSessionId]);
  });
});

describe('DELETE /v1/identity/scanner-sessions/{sessionId}(I-T89 ③~⑤)', () => {
  test('I-T89 ③ 재인증 토큰이 없으면 403 reauth-required이고 세션은 그대로다 [ASVS v5.0.0-7.5.2]', async () => {
    const s = await login('scn-del-none');
    const seeded = await seedScanner(s, { deviceName: '동문-21' });
    const r = await end(s, seeded.scannerSessionId);
    expect(r.statusCode).toBe(403);
    expect(problem(r).type.split('/').pop()).toBe('reauth-required');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(terminatedAt(seeded.scannerSessionId)).toBeNull();
  });

  test('I-T89 ③ 다른 작업(SESSION_END)의 재인증 토큰은 403이고 세션은 그대로다 [ASVS v5.0.0-7.5.2]', async () => {
    const s = await login('scn-del-op');
    const seeded = await seedScanner(s, { deviceName: '동문-22' });
    const r = await end(s, seeded.scannerSessionId, await reauth(s, 'SESSION_END'));
    expect(r.statusCode).toBe(403);
    expect(problem(r).type.split('/').pop()).toBe('reauth-required');
    expect(terminatedAt(seeded.scannerSessionId)).toBeNull();
  });

  test('I-T89 ③ 같은 계정의 다른 팬 세션이 받은 토큰은 403이고 세션은 그대로다 [ASVS v5.0.0-7.5.2]', async () => {
    const phone = await login('scn-del-sid', 'dev-phone-1');
    const laptop = await login('scn-del-sid', 'dev-laptop-1');
    expect(laptop.accountId).toBe(phone.accountId);
    expect(laptop.sessionId).not.toBe(phone.sessionId);
    const seeded = await seedScanner(phone, { deviceName: '동문-23' });
    const r = await end(phone, seeded.scannerSessionId, await reauth(laptop, 'SCANNER_SESSION_END'));
    expect(r.statusCode).toBe(403);
    expect(problem(r).type.split('/').pop()).toBe('reauth-required');
    expect(terminatedAt(seeded.scannerSessionId)).toBeNull();
  });

  test('I-T89 ③ 만료된(5분 지난) 재인증 토큰은 403이고 세션은 그대로다 [ASVS v5.0.0-7.5.2]', async () => {
    const s = await login('scn-del-exp');
    const seeded = await seedScanner(s, { deviceName: '동문-24' });
    const token = await reauth(s, 'SCANNER_SESSION_END');
    clock.advance(5 * 60_000 + 1);
    const r = await end(s, seeded.scannerSessionId, token);
    expect(r.statusCode).toBe(403);
    expect(problem(r).type.split('/').pop()).toBe('reauth-required');
    expect(terminatedAt(seeded.scannerSessionId)).toBeNull();
  });

  test('I-T89 ④ 맞는 토큰이면 204이고 terminated_at이 지금이며 LOGOUT 사건 한 건, 그 뒤 CheckScannerSession은 거절하고 같은 토큰 재사용은 403이다 [ASVS v5.0.0-10.4.9]', async () => {
    const s = await login('scn-del-ok');
    const seeded = await seedScanner(s, { deviceName: '동문-25' });
    const check = svc.app.get(CheckScannerSession);
    expect((await check.run({ scannerSessionId: seeded.scannerSessionId, deviceId: seeded.deviceId })).valid).toBe(true);
    const eventsBefore = staff.terminatedEvents.length;
    const token = await reauth(s, 'SCANNER_SESSION_END');
    const r = await end(s, seeded.scannerSessionId, token);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(terminatedAt(seeded.scannerSessionId)).toBe(svc.clock.now());
    expect(staff.terminatedEvents.slice(eventsBefore)).toEqual([
      { accountId: s.accountId, sessionId: seeded.scannerSessionId, reason: 'LOGOUT', terminatedAt: new Date(svc.clock.now()).toISOString() },
    ]);
    expect((await check.run({ scannerSessionId: seeded.scannerSessionId, deviceId: seeded.deviceId })).valid).toBe(false);
    expect(JSON.parse((await list(s)).body)).toEqual({ items: [] });
    // 같은 토큰을 새 세션에 다시 보내도 403(한 번 쓴 토큰)
    const again = await seedScanner(s, { deviceName: '동문-26' });
    const reused = await end(s, again.scannerSessionId, token);
    expect(reused.statusCode).toBe(403);
    expect(problem(reused).type.split('/').pop()).toBe('reauth-required');
    expect(terminatedAt(again.scannerSessionId)).toBeNull();
  });

  test('I-T89 ⑤ 다른 계정의 세션·이미 끝난 세션·없는 ID·모양이 틀린 ID는 같은 404이고 토큰을 쓰지 않아 바로 뒤 자기 세션에는 204다', async () => {
    const me = await login('scn-404-me');
    const other = await login('scn-404-other');
    const theirs = await seedScanner(other, { deviceName: '서문-31' });
    const old = await seedScanner(me, { deviceName: '서문-32' });
    staff.sessions.set(old.scannerSessionId, { ...staff.sessions.get(old.scannerSessionId)!, terminatedAt: svc.clock.now() });
    const mine = await seedScanner(me, { deviceName: '서문-33' });
    const token = await reauth(me, 'SCANNER_SESSION_END');
    const answers = [await end(me, theirs.scannerSessionId, token), await end(me, old.scannerSessionId, token), await end(me, uuid(0xfffff), token), await end(me, 'not-a-uuid', token)];
    for (const r of answers) {
      expect(r.statusCode).toBe(404);
      expect(problem(r)).toMatchObject({ status: 404 });
      expect(problem(r).type.split('/').pop()).toBe('session-not-found');
    }
    // 본문이 같다(남의 세션인지 없는 세션인지 가를 수 없다)
    const bodies = answers.map((r) => {
      const { type, status, title } = problem(r);
      return { type, status, title };
    });
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(terminatedAt(theirs.scannerSessionId)).toBeNull();
    const ok = await end(me, mine.scannerSessionId, token);
    expect(ok.statusCode).toBe(204);
    expect(terminatedAt(mine.scannerSessionId)).toBe(svc.clock.now());
  });

  test('I-T89 신원 없는 요청은 401이다(조회·끝내기)', async () => {
    expect((await svc.http.inject({ method: 'GET', url: URL_BASE })).statusCode).toBe(401);
    expect((await svc.http.inject({ method: 'DELETE', url: `${URL_BASE}/${uuid(1)}` })).statusCode).toBe(401);
  });
});
