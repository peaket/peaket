// 재발급 재인증과 403 가르기 HTTP 시험(BUILD_ORDER GAT-020, F-05-1, docs/features/offline-gate.md §11 O-T47·O-T6, ADR-0363 결정 1·2,
// docs/security/authz-matrix.md §6 받는 쪽 작업 DEVICE_KEY_ISSUE·작업 묶음 FAN_SENSITIVE, openapi createTicketDeviceKey 403 설명).
// - 조립은 시작 파일과 같은 함수(start.ts assembleDeviceKeys)다. 재인증 확인기는 진짜 JwksFanReauthGate이고, 바꿔 끼우는 것은
//   팬 공개키 묶음 읽기(fetch 경계)·jti 기록(MemoryReauthJtiStore, 플랫폼의 짝 가짜)·시계·기기 키 저장소(MemoryDeviceKeyStore, DrizzleDeviceKeyStore의 짝 가짜)다.
//   같은 규칙의 실제 DB 쪽(device_key 행·scanner_change 줄)은 test-int/device-key-reissue.int.test.ts가 본다.
// - 단언 값(문제 이름·남은 수명 5분 30초·24시간·입장 시작 경계)은 정본 글에서 적는다. 시험 시각은 코드 상수와 겹치지 않게 고른다.
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, MemoryDpopReplayStore, MemoryReauthJtiStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { JwksFanReauthGate } from '../src/modules/ticket/adapters/jwks-fan-reauth-gate.js';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import type { DeviceKeyRegistrationOutcome } from '../src/modules/ticket/application/device-keys.js';
import { deviceKeyMaterialOf, keyIdTextOf, type PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';
import { assembleDeviceKeys } from '../src/start.js';

/** 시험 시각(KST 2026-11-23 13:07:11.000) */
const T0 = Date.parse('2026-11-23T04:07:11.000Z');
const HOUR = 60 * 60_000;
const ISS = 'https://identity.f051.test';
const JWKS_URL = 'https://identity.f051.test/internal/jwks/fan.json';
const ACCOUNT = '0193f2c0-0000-7000-8000-00000000f051';
const SESSION = '0193f2c0-0000-7000-8000-00000000f052';
const OTHER_ACCOUNT = '0193f2c0-0000-7000-8000-00000000f053';
const OTHER_SESSION = '0193f2c0-0000-7000-8000-00000000f054';
const EVENT = '0193f2c0-0000-7000-8000-00000000f055';
/** 입장 시작 전 티켓(입장 시작 = T0 + 3일) */
const BEFORE = '0193f2c0-0000-7000-8000-00000000f101';
/** 입장 시작 뒤 티켓(입장 시작 = T0 - 1분), 기기 A 키 있음 */
const AFTER = '0193f2c0-0000-7000-8000-00000000f102';
/** 입장 시작 뒤 키가 없는 티켓 */
const AFTER_EMPTY = '0193f2c0-0000-7000-8000-00000000f103';

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

// 팬 재인증 토큰 서명 키(시험 키)와 그 공개키 묶음
const fanKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const fanJwk = fanKey.publicKey.export({ format: 'jwk' }) as Record<string, string>;
const JWKS = { keys: [{ kty: 'EC', crv: 'P-256', x: fanJwk.x!, y: fanJwk.y!, kid: 'fan-f051', alg: 'ES256', use: 'sig' }] };
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

async function deviceJwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}
const keyIdOf = (jwk: PublicKeyJwk): string => keyIdTextOf(deviceKeyMaterialOf(jwk).keyId);
const problemName = (payload: string): string => String((JSON.parse(payload) as { type?: unknown }).type ?? '').split('/').pop() ?? '';

interface Harness {
  svc: Awaited<ReturnType<typeof createService>>;
  store: MemoryDeviceKeyStore;
  clock: ReturnType<typeof fakeClock>;
  /** 팬 공개키 묶음 서버가 답하는가(⑧) */
  jwksUp: { value: boolean };
  outcomes: DeviceKeyRegistrationOutcome[];
  /** 지금 시계로 서명한 재인증 토큰. 기본은 기기 키 등록의 받는 쪽 작업(authz-matrix §6) */
  token(over?: Record<string, unknown>): string;
  post(ticketId: string, body: unknown, o?: { token?: string; account?: string; session?: string }): Promise<{ statusCode: number; payload: string }>;
  /** 그 티켓의 유효 keyId 목록 */
  active(ticketId: string): Promise<string[]>;
}

const opened: Harness[] = [];

/** 시계를 그 시각으로(앞으로만) 옮긴다 */
const to = (h: Harness, atMs: number): void => h.clock.advance(atMs - h.clock.now());

/** 시험마다 새 서비스·저장소·시계(TA-V01). 티켓 셋과 기기 A 키(BEFORE·AFTER)를 심는다 */
async function harness(): Promise<Harness & { keyA: { before: string; after: string } }> {
  const clock = fakeClock({ now: T0 });
  const store = new MemoryDeviceKeyStore();
  const jwksUp = { value: true };
  const outcomes: DeviceKeyRegistrationOutcome[] = [];
  const gate = new JwksFanReauthGate({
    jwksUrl: JWKS_URL,
    issuer: ISS,
    jti: new MemoryReauthJtiStore(),
    clock,
    fetch: async () => (jwksUp.value ? new Response(JSON.stringify(JWKS), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('down', { status: 503 })),
  });
  const { deviceKeys } = assembleDeviceKeys({ store, reauth: gate, clock, observe: (o) => outcomes.push(o.result) });
  const replay = new MemoryDpopReplayStore(clock);
  const gateStore = new MemoryScannerGateStore(store);
  const devices = new MemoryScannerDeviceStore();
  const svc = await createService({
    name: 'ticket-svc-device-key-reauth',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate: gateStore, shift: new MemoryScannerShiftStore(gateStore) },
      ticket: { deviceKeys },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
  const token = (over: Record<string, unknown> = {}): string => {
    const nowS = Math.floor(clock.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: ISS,
      sub: ACCOUNT,
      aud: 'fan',
      iat: nowS,
      exp: nowS + 180,
      sid: SESSION,
      jti: randomUUID(),
      act: 'FAN_SENSITIVE',
      op: 'DEVICE_KEY_ISSUE',
      ...over,
    };
    const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid: 'fan-f051' });
    const body = b64(claims);
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: fanKey.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${head}.${body}.${sig.toString('base64url')}`;
  };
  const post: Harness['post'] = async (ticketId, body, o = {}) =>
    svc.http.inject({
      method: 'POST',
      url: `/v1/tickets/${ticketId}/device-keys`,
      headers: {
        'x-user-id': o.account ?? ACCOUNT,
        'x-session-id': o.session ?? SESSION,
        'x-user-aud': 'fan',
        'content-type': 'application/json',
        ...(o.token ? { 'x-reauth-token': o.token } : {}),
      },
      payload: JSON.stringify(body),
    });
  const active = async (ticketId: string) => ((await store.activeKeysByEvent(EVENT)).get(ticketId) ?? []).map((k) => k.keyId);

  // 기기 A 키: 입장 시작 전에 첫 등록한 뒤 AFTER 티켓의 입장 시작을 지난 시각으로 옮긴다(소유권 동결 전 등록)
  store.seedTicket({ ticketId: BEFORE, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 + 72 * HOUR });
  store.seedTicket({ ticketId: AFTER, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 + 72 * HOUR });
  const a1 = await deviceJwk();
  const a2 = await deviceJwk();
  for (const [t, jwk] of [
    [BEFORE, a1],
    [AFTER, a2],
  ] as const) {
    const r = await post(t, { publicKeyJwk: jwk, reason: 'ISSUE' });
    expect(r.statusCode, `기기 A 첫 등록 ${t}`).toBe(201);
  }
  store.seedTicket({ ticketId: AFTER, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 - 60_000 });
  store.seedTicket({ ticketId: AFTER_EMPTY, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 - 60_000 });
  outcomes.length = 0;
  const h = { svc, store, clock, jwksUp, outcomes, token, post, active, keyA: { before: keyIdOf(a1), after: keyIdOf(a2) } };
  opened.push(h);
  return h;
}

afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close().catch(() => {});
});

describe('O-T47 재발급 재인증과 403 가르기 [GAT-020]', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });

  test('O-T47 ① 입장 시작 전, 재인증 없이 기기 B 키로 REISSUE하면 403 reissue-required이고 기기 A 키가 그대로다', async () => {
    const r = await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' });
    expect(r.statusCode).toBe(403);
    expect(problemName(r.payload)).toBe('reissue-required');
    expect(await h.active(BEFORE)).toEqual([h.keyA.before]);
    expect(await h.store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
    expect(h.store.notices).toEqual([]);
    // 지표 결과 이름(offline-gate §10.1)
    expect(h.outcomes).toEqual(['reissue_required']);
  });

  test('O-T47 ② 입장 시작 전, DEVICE_KEY_ISSUE·같은 세션 토큰으로 REISSUE하면 201(기기 B keyId)이고 기기 A 키는 폐기된다 [ASVS v5.0.0-7.5.1]', async () => {
    const b = await deviceJwk();
    const r = await h.post(BEFORE, { publicKeyJwk: b, reason: 'REISSUE' }, { token: h.token() });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toEqual({ keyId: keyIdOf(b) });
    expect(await h.active(BEFORE)).toEqual([keyIdOf(b)]);
    expect(await h.store.revokedKeyIdsByEvent(EVENT)).toEqual([h.keyA.before]);
    expect(await h.store.keyState(BEFORE, Buffer.from(h.keyA.before, 'base64url'))).toBe('REVOKED');
    expect(h.outcomes).toEqual(['registered']);
  });

  test('O-T47 ③ ②의 토큰을 한 번 더 쓰면 403 reissue-required다(같은 jti는 한 번만)', async () => {
    const t = h.token();
    const b = await deviceJwk();
    expect((await h.post(BEFORE, { publicKeyJwk: b, reason: 'REISSUE' }, { token: t })).statusCode).toBe(201);
    const again = await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: t });
    expect(again.statusCode).toBe(403);
    expect(problemName(again.payload)).toBe('reissue-required');
    expect(await h.active(BEFORE)).toEqual([keyIdOf(b)]);
    // 다른 티켓에 같은 토큰을 써도 거절한다(jti는 티켓이 아니라 토큰마다 한 번)
    const other = await h.post(AFTER_EMPTY, { publicKeyJwk: await deviceJwk(), reason: 'ISSUE' }, { token: t });
    expect(other.statusCode).toBe(403);
    expect(problemName(other.payload)).toBe('reauth-required');
    expect(await h.active(AFTER_EMPTY)).toEqual([]);
  });

  test('O-T47 ④ 받는 쪽 작업 TICKET_RETURN 토큰·다른 세션 토큰·다른 계정 토큰·남은 수명이 5분 30초를 넘는 토큰은 기기 키 등록에서 거절된다 [ASVS v5.0.0-7.5.1]', async () => {
    const nowS = Math.floor(T0 / 1000);
    for (const [label, over] of [
      ['받는 쪽 작업 TICKET_RETURN', { op: 'TICKET_RETURN' }],
      ['받는 쪽 작업 TRANSFER_REQUEST·작업 묶음 FAN_HIGH_RISK', { op: 'TRANSFER_REQUEST', act: 'FAN_HIGH_RISK' }],
      ['작업 묶음 FAN_HIGH_RISK', { act: 'FAN_HIGH_RISK' }],
      ['다른 세션', { sid: OTHER_SESSION }],
      ['다른 계정', { sub: OTHER_ACCOUNT }],
      ['남은 수명 5분 30초 + 1초', { exp: nowS + 331 }],
    ] as const) {
      const r = await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: h.token(over) });
      expect(r.statusCode, label).toBe(403);
      expect(problemName(r.payload), label).toBe('reissue-required');
      expect(await h.active(BEFORE), label).toEqual([h.keyA.before]);
    }
    expect(await h.store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
    // 대조: 남은 수명이 꼭 5분 30초인 토큰은 받는다(경계 안쪽)
    const edge = await deviceJwk();
    const ok = await h.post(BEFORE, { publicKeyJwk: edge, reason: 'REISSUE' }, { token: h.token({ exp: nowS + 330 }) });
    expect(ok.statusCode).toBe(201);
    expect(await h.active(BEFORE)).toEqual([keyIdOf(edge)]);
  });

  test('O-T47 ⑤ ② 뒤 23시간 59분에 다른 키로 다시 REISSUE하면 429이고, 24시간 1ms 전도 429, 24시간이 지나면 된다', async () => {
    const b = await deviceJwk();
    expect((await h.post(BEFORE, { publicKeyJwk: b, reason: 'REISSUE' }, { token: h.token() })).statusCode).toBe(201);
    for (const at of [23 * HOUR + 59 * 60_000, 24 * HOUR - 1]) {
      to(h, T0 + at);
      const r = await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: h.token() });
      expect(r.statusCode, `② 뒤 ${at}ms`).toBe(429);
      expect(problemName(r.payload)).toBe('too-many-requests');
      expect(await h.active(BEFORE)).toEqual([keyIdOf(b)]);
    }
    to(h, T0 + 24 * HOUR);
    const c = await deviceJwk();
    const later = await h.post(BEFORE, { publicKeyJwk: c, reason: 'REISSUE' }, { token: h.token() });
    expect(later.statusCode).toBe(201);
    expect(await h.active(BEFORE)).toEqual([keyIdOf(c)]);
    expect(h.outcomes).toEqual(['registered', 'limit', 'limit', 'registered']);
  });

  test('O-T47 ⑥ 입장 시작 뒤, 맞는 토큰의 REISSUE·ISSUE와 토큰 없는 ISSUE는 셋 다 403 reissue-at-booth이고 키·폐기 목록이 그대로다', async () => {
    for (const [label, body, token] of [
      ['맞는 토큰 REISSUE', { reason: 'REISSUE' }, true],
      ['맞는 토큰 ISSUE', { reason: 'ISSUE' }, true],
      ['토큰 없는 ISSUE', { reason: 'ISSUE' }, false],
    ] as const) {
      const r = await h.post(AFTER, { publicKeyJwk: await deviceJwk(), ...body }, token ? { token: h.token() } : {});
      expect(r.statusCode, label).toBe(403);
      expect(problemName(r.payload), label).toBe('reissue-at-booth');
      expect(await h.active(AFTER), label).toEqual([h.keyA.after]);
    }
    expect(await h.store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
    expect(h.store.notices).toEqual([]);
    expect(h.outcomes).toEqual(['reissue_at_booth', 'reissue_at_booth', 'reissue_at_booth']);
  });

  test('O-T47 ⑥ 입장 시작 정각은 이미 시작이고 1ms 전은 아직 전이다(경계 양쪽)', async () => {
    const startsAt = T0 + 5 * HOUR;
    h.store.seedTicket({ ticketId: BEFORE, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: startsAt });
    to(h, startsAt - 1);
    const b = await deviceJwk();
    const justBefore = await h.post(BEFORE, { publicKeyJwk: b, reason: 'REISSUE' }, { token: h.token() });
    expect(justBefore.statusCode).toBe(201);
    expect(await h.active(BEFORE)).toEqual([keyIdOf(b)]);
    to(h, startsAt);
    const atStart = await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: h.token() });
    expect(atStart.statusCode).toBe(403);
    expect(problemName(atStart.payload)).toBe('reissue-at-booth');
    expect(await h.active(BEFORE)).toEqual([keyIdOf(b)]);
  });

  test('O-T47 ⑦ 입장 시작 뒤 키가 없는 티켓에 토큰 없는 ISSUE는 403 reauth-required, 맞는 토큰 ISSUE는 201이다', async () => {
    const none = await h.post(AFTER_EMPTY, { publicKeyJwk: await deviceJwk(), reason: 'ISSUE' });
    expect(none.statusCode).toBe(403);
    expect(problemName(none.payload)).toBe('reauth-required');
    expect(await h.active(AFTER_EMPTY)).toEqual([]);
    const b = await deviceJwk();
    const ok = await h.post(AFTER_EMPTY, { publicKeyJwk: b, reason: 'ISSUE' }, { token: h.token() });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.payload)).toEqual({ keyId: keyIdOf(b) });
    expect(await h.active(AFTER_EMPTY)).toEqual([keyIdOf(b)]);
    expect(h.outcomes).toEqual(['reauth_required', 'registered']);
  });

  test('O-T47 ⑧ 팬 공개키 묶음을 읽지 못하면 503 reauth-unavailable이고 아무것도 바꾸지 않는다', async () => {
    h.jwksUp.value = false;
    for (const [ticketId, reason] of [
      [BEFORE, 'REISSUE'],
      [AFTER_EMPTY, 'ISSUE'],
    ] as const) {
      const r = await h.post(ticketId, { publicKeyJwk: await deviceJwk(), reason }, { token: h.token() });
      expect(r.statusCode, `${ticketId} ${reason}`).toBe(503);
      expect(problemName(r.payload)).toBe('reauth-unavailable');
    }
    expect(await h.active(BEFORE)).toEqual([h.keyA.before]);
    expect(await h.active(AFTER_EMPTY)).toEqual([]);
    expect(await h.store.revokedKeyIdsByEvent(EVENT)).toEqual([]);
    expect(h.outcomes).toEqual(['reauth_unavailable', 'reauth_unavailable']);
  });

  test('O-T47 남의 티켓은 그 사람의 맞는 토큰이 있어도 404다(계정 대조)', async () => {
    const r = await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: h.token({ sub: OTHER_ACCOUNT, sid: OTHER_SESSION }), account: OTHER_ACCOUNT, session: OTHER_SESSION });
    expect(r.statusCode).toBe(404);
    expect(problemName(r.payload)).toBe('not-found');
    expect(await h.active(BEFORE)).toEqual([h.keyA.before]);
  });

  test('O-T6 입장 시작 전 재인증 뒤 재발급되고 옛 키가 폐기 목록에 오르며 24시간 안 두 번째는 429, 입장 시작 뒤는 reissue-at-booth다', async () => {
    const b = await deviceJwk();
    expect((await h.post(BEFORE, { publicKeyJwk: b, reason: 'REISSUE' }, { token: h.token() })).statusCode).toBe(201);
    expect(await h.store.revokedKeyIdsByEvent(EVENT)).toEqual([h.keyA.before]);
    h.clock.advance(HOUR);
    expect((await h.post(BEFORE, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: h.token() })).statusCode).toBe(429);
    const booth = await h.post(AFTER, { publicKeyJwk: await deviceJwk(), reason: 'REISSUE' }, { token: h.token() });
    expect(booth.statusCode).toBe(403);
    expect(problemName(booth.payload)).toBe('reissue-at-booth');
  });
});
