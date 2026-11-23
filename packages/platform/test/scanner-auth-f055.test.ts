// F-05-5(GAT-170 마감) 스캐너 가드의 거절 이유·경계·장애 주입·출처 확인 단위 시험.
// 정본: docs/features/offline-gate.md §6.1 'GAT-170 마감 규칙'(이유 이름표 18가지·출처 규칙)·§6.2(세션 5초 캐시)·§6.6, O-T21 ①·O-T35·O-T37,
// docs/security/authz-matrix.md §5.2, 계획 docs/review/plans/F-05-5.md §5(공개 인터페이스)·§6.
// 단언 값(±5분 = 300,000ms, jti 10분 = 600,000ms, 캐시 5초 = 5,000ms, Retry-After 1초, 허용 출처 https://scanner.peaket.example)은
// 정본에서 적는다. 코드 상수(SCANNER_DPOP_IAT_WINDOW_MS 등)를 가져오지 않는다. 시계는 fakeClock으로만 민다.
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  ProblemError,
  Roles,
  SCANNER_AUTH_REJECTIONS,
  SCANNER_PWA_ORIGIN_ENV,
  ScannerAuth,
  assertScannerOrigin,
  athOf,
  createService,
  fakeClock,
  scannerPwaOriginFromEnv,
  type DpopReplayStore,
  type FakeClock,
  type Principal,
  type ScannerAuthRejection,
  type ScannerAuthWiring,
  type ScannerDeviceLookup,
  type ScannerDeviceRecord,
  type ScannerSessionAnswer,
  type ScannerSessionCheck,
} from '../src/index.js';
import { collector } from './fixture.js';

const HOST = 'scanner-api.peaket.example';
const PWA_ORIGIN = 'https://scanner.peaket.example';

@Controller('v1/f055')
class StaffController {
  @Get('shift')
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  shift(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId };
  }

  @Get('lead')
  @Roles(['gate_lead'])
  @ScannerAuth()
  lead() {
    return { ok: true };
  }

  @Get('device')
  @Roles(['scanner_device'])
  @ScannerAuth({ token: 'none', device: 'registered' })
  device(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId };
  }

  @Get('scans')
  @Roles(['scanner_device', 'gate_staff', 'gate_lead'])
  @ScannerAuth({ token: 'optional', device: 'registered' })
  scans(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId };
  }
}

@Module({ controllers: [StaffController] })
class StaffModule {}

/** 기기 원장 대역(ScannerDeviceLookup 포트). fail이면 원장에 닿지 못한 것처럼 던진다 */
class Devices implements ScannerDeviceLookup {
  readonly byJkt = new Map<string, ScannerDeviceRecord>();
  lookups = 0;
  fail = false;
  touchFails = false;
  touched = 0;
  async byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null> {
    this.lookups += 1;
    if (this.fail) throw new Error('기기 원장에 닿지 못함(시험 장애 주입)');
    return this.byJkt.get(jkt) ?? null;
  }
  async touch(): Promise<void> {
    this.touched += 1;
    if (this.touchFails) throw new Error('last_seen_at 갱신 실패(시험 장애 주입)');
  }
}

/** identity CheckScannerSession 대역(ScannerSessionCheck 포트). fail이면 identity가 멈춘 것처럼 던진다 */
class Sessions implements ScannerSessionCheck {
  answer: ScannerSessionAnswer = { valid: true, role: 'gate_staff', eventId: 'ev-1' };
  calls = 0;
  fail = false;
  async check(): Promise<ScannerSessionAnswer> {
    this.calls += 1;
    if (this.fail) throw new Error('identity-svc 멈춤(시험 장애 주입)');
    return this.answer;
  }
}

/** jti 저장소 대역(DpopReplayStore 포트). 받은 ttl을 적는다. fail이면 Redis에 닿지 못한 것처럼 던진다 */
class Replay implements DpopReplayStore {
  readonly used = new Set<string>();
  readonly claims: { jti: string; ttlMs: number }[] = [];
  fail = false;
  async claim(jti: string, ttlMs: number): Promise<boolean> {
    if (this.fail) throw new Error('jti 저장소에 닿지 못함(시험 장애 주입)');
    this.claims.push({ jti, ttlMs });
    if (this.used.has(jti)) return false;
    this.used.add(jti);
    return true;
  }
}

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
interface Key {
  privateKey: KeyPair['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

async function keyOf(alg: 'ES256' | 'ES384' = 'ES256'): Promise<Key> {
  const pair = await generateKeyPair(alg, { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

const TOKEN = 'f055-staff-token';
const ATH = athOf(TOKEN);
/** 시험 시각(초 단위로 떨어지게 둔다). 증명 iat의 기준이다 */
const T0 = Date.parse('2026-11-23T03:00:00.000Z');
const IAT = T0 / 1000;

let jtiSeq = 0;
async function proofOf(
  key: Key,
  o: { jti?: string; htm?: string; path?: string; htu?: string; iat?: number; ath?: string | null; typ?: string; alg?: string; jwk?: Record<string, unknown>; signer?: Key } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    jti: o.jti ?? `f055-${++jtiSeq}`,
    htm: o.htm ?? 'GET',
    htu: o.htu ?? `https://${HOST}${o.path ?? '/v1/f055/shift'}`,
    iat: o.iat ?? IAT,
  };
  if (o.ath !== null) payload.ath = o.ath ?? ATH;
  return new SignJWT(payload)
    .setProtectedHeader({ typ: o.typ ?? 'dpop+jwt', alg: o.alg ?? 'ES256', jwk: (o.jwk ?? key.jwk) as never })
    .sign((o.signer ?? key).privateKey);
}

function staffHeaders(proof: string | undefined, jkt: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-user-id': 'acc-staff',
    'x-session-id': 'sess-1',
    'x-user-aud': 'scanner',
    'x-user-jkt': jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    ...(proof !== undefined ? { dpop: proof } : {}),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': HOST,
    ...extra,
  };
}

interface Booted {
  clock: FakeClock;
  devices: Devices;
  sessions: Sessions;
  replay: Replay;
  rejections: ScannerAuthRejection[];
  key: Key;
  get(headers: Record<string, string>, path?: string): Promise<{ statusCode: number; headers: Record<string, unknown>; payload: string }>;
}

const started: Awaited<ReturnType<typeof createService>>[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function boot(o: { now?: number; onRejected?: (reason: ScannerAuthRejection) => void } = {}): Promise<Booted> {
  const clock = fakeClock({ now: o.now ?? T0 });
  const devices = new Devices();
  const sessions = new Sessions();
  const replay = new Replay();
  const rejections: ScannerAuthRejection[] = [];
  const key = await keyOf();
  devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
  const scanner: ScannerAuthWiring = {
    devices,
    sessions,
    replay,
    onRejected: o.onRejected ?? ((reason: ScannerAuthRejection) => void rejections.push(reason)),
  };
  const logs = collector();
  const svc = await createService({
    name: 'scanner-auth-f055',
    module: StaffModule,
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: logs.stream,
    scanner,
  });
  started.push(svc);
  return {
    clock,
    devices,
    sessions,
    replay,
    rejections,
    key,
    get: (headers, path = '/v1/f055/shift') => svc.http.inject({ method: 'GET', url: path, headers }),
  };
}

const problemType = (payload: string): unknown => (JSON.parse(payload) as { type?: unknown }).type;

describe('O-T37 ⑨ 스캐너 인증 거절 이유 이름표(offline-gate §6.1 GAT-170 마감 규칙)', () => {
  test('O-T37 ⑨ 이름표는 정본의 18가지가 정본 차례 그대로다 [ASVS v5.0.0-16.3.4]', () => {
    expect([...SCANNER_AUTH_REJECTIONS]).toEqual([
      'format', 'typ', 'alg', 'jwk', 'signature', 'htm', 'htu', 'iat', 'ath', 'jti', 'cnf',
      'proof_missing', 'token', 'session', 'role', 'device_unregistered', 'device_revoked', 'unavailable',
    ]);
    expect(new Set(SCANNER_AUTH_REJECTIONS).size).toBe(18);
  });

  test('O-T37 ⑨ 통과한 요청은 onRejected를 한 번도 부르지 않는다', async () => {
    const b = await boot();
    const r = await b.get(staffHeaders(await proofOf(b.key), b.key.jkt));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ role: 'gate_staff', deviceId: 'dev-1' });
    const d = await b.get({ dpop: await proofOf(b.key, { path: '/v1/f055/device', ath: null }), 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST }, '/v1/f055/device');
    expect(d.statusCode).toBe(200);
    expect(b.rejections).toEqual([]);
  });

  test('O-T37 ⑨ 증명 거절 열한 가지는 401 invalid_dpop_proof이고 그 이유 이름표 하나씩만 남는다 [ASVS v5.0.0-16.3.4]', async () => {
    const b = await boot();
    const other = await keyOf();
    const p384 = await keyOf('ES384');
    const cases: { reason: ScannerAuthRejection; headers: () => Promise<Record<string, string>> }[] = [
      { reason: 'format', headers: async () => staffHeaders('not-a-jwt', b.key.jkt) },
      { reason: 'typ', headers: async () => staffHeaders(await proofOf(b.key, { typ: 'JWT' }), b.key.jkt) },
      { reason: 'alg', headers: async () => staffHeaders(await proofOf(p384, { alg: 'ES384' }), b.key.jkt) },
      { reason: 'jwk', headers: async () => staffHeaders(await proofOf(b.key, { jwk: { ...b.key.jwk, d: 'private-part' } }), b.key.jkt) },
      // 헤더 jwk는 이 기기 키, 서명은 다른 키
      { reason: 'signature', headers: async () => staffHeaders(await proofOf(b.key, { signer: other }), b.key.jkt) },
      { reason: 'htm', headers: async () => staffHeaders(await proofOf(b.key, { htm: 'POST' }), b.key.jkt) },
      { reason: 'htu', headers: async () => staffHeaders(await proofOf(b.key, { htu: `https://${HOST}/v1/f055/other` }), b.key.jkt) },
      { reason: 'iat', headers: async () => staffHeaders(await proofOf(b.key, { iat: IAT - 6 * 60 }), b.key.jkt) },
      { reason: 'ath', headers: async () => staffHeaders(await proofOf(b.key, { ath: athOf('another-token') }), b.key.jkt) },
      // 토큰의 cnf.jkt(X-User-Jkt)가 다른 기기 키
      { reason: 'cnf', headers: async () => staffHeaders(await proofOf(b.key), other.jkt) },
    ];
    for (const c of cases) {
      b.rejections.length = 0;
      const r = await b.get(await c.headers());
      expect(r.statusCode, c.reason).toBe(401);
      expect(r.headers['www-authenticate'], c.reason).toBe('DPoP error="invalid_dpop_proof"');
      expect(b.rejections, c.reason).toEqual([c.reason]);
    }
    // jti: 처음은 통과(이름표 없음), 같은 증명 두 번째가 jti
    b.rejections.length = 0;
    const once = await proofOf(b.key);
    expect((await b.get(staffHeaders(once, b.key.jkt))).statusCode).toBe(200);
    const again = await b.get(staffHeaders(once, b.key.jkt));
    expect(again.statusCode).toBe(401);
    expect(again.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(b.rejections).toEqual(['jti']);
  });

  test('O-T37 ⑨ 증명 없음·토큰·세션·역할·미등록·폐기·판정 불가는 각각 정본 응답과 이름표 하나다 [ASVS v5.0.0-16.3.4]', async () => {
    const b = await boot();
    const once = async (headers: Record<string, string>, path?: string) => {
      b.rejections.length = 0;
      return b.get(headers, path);
    };

    const missing = await once(staffHeaders(undefined, b.key.jkt));
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(b.rejections).toEqual(['proof_missing']);

    // 토큰이 선택인 경로(업로드 꼴)에 토큰은 붙었는데 게이트웨이 신원 머리가 없다
    const noIdentity = await once(
      { dpop: await proofOf(b.key, { path: '/v1/f055/scans' }), authorization: `DPoP ${TOKEN}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST },
      '/v1/f055/scans',
    );
    expect(noIdentity.statusCode).toBe(401);
    expect(noIdentity.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
    expect(b.rejections).toEqual(['token']);

    // X-User-Ath가 붙은 토큰의 해시와 다름
    const athMismatch = await once(staffHeaders(await proofOf(b.key), b.key.jkt, { 'x-user-ath': athOf('forged') }));
    expect(athMismatch.statusCode).toBe(401);
    expect(athMismatch.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
    expect(b.rejections).toEqual(['token']);

    // 기기 전용 경로에 사람 토큰
    const tokenOnDevice = await once(
      { dpop: await proofOf(b.key, { path: '/v1/f055/device', ath: null }), authorization: `DPoP ${TOKEN}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST },
      '/v1/f055/device',
    );
    expect(tokenOnDevice.statusCode).toBe(401);
    expect(b.rejections).toEqual(['token']);

    b.sessions.answer = { valid: false, role: 'gate_staff', eventId: 'ev-1' };
    const invalid = await once(staffHeaders(await proofOf(b.key), b.key.jkt, { 'x-session-id': 'sess-invalid' }));
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
    expect(b.rejections).toEqual(['session']);

    b.sessions.answer = { valid: true, eventId: 'ev-1' };
    const roleless = await once(staffHeaders(await proofOf(b.key), b.key.jkt, { 'x-session-id': 'sess-roleless' }));
    expect(roleless.statusCode).toBe(401);
    expect(b.rejections).toEqual(['session']);

    b.sessions.answer = { valid: true, role: 'gate_staff', eventId: 'ev-1' };
    const role = await once(staffHeaders(await proofOf(b.key, { path: '/v1/f055/lead' }), b.key.jkt, { 'x-session-id': 'sess-staff' }), '/v1/f055/lead');
    expect(role.statusCode).toBe(403);
    expect(b.rejections).toEqual(['role']);

    const stranger = await keyOf();
    const unregistered = await once(staffHeaders(await proofOf(stranger), stranger.jkt));
    expect(unregistered.statusCode).toBe(403);
    expect(problemType(unregistered.payload)).toBe('https://peaket.example/problems/device-unregistered');
    expect(b.rejections).toEqual(['device_unregistered']);

    b.devices.byJkt.set(b.key.jkt, { deviceId: 'dev-1', status: 'REVOKED', promoterId: 'prom-1' });
    const revoked = await once(staffHeaders(await proofOf(b.key), b.key.jkt));
    expect(revoked.statusCode).toBe(403);
    expect(problemType(revoked.payload)).toBe('https://peaket.example/problems/device-revoked');
    expect(b.rejections).toEqual(['device_revoked']);

    b.devices.byJkt.set(b.key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.fail = true;
    const unavailable = await once(staffHeaders(await proofOf(b.key), b.key.jkt, { 'x-session-id': 'sess-uncached' }));
    expect(unavailable.statusCode).toBe(503);
    expect(b.rejections).toEqual(['unavailable']);
  });

  test('O-T37 ⑨ onRejected가 던져도 거절 응답은 그대로다', async () => {
    let called = 0;
    const b = await boot({
      onRejected: () => {
        called += 1;
        throw new Error('지표 기록 실패(시험)');
      },
    });
    const r = await b.get(staffHeaders(await proofOf(b.key, { htm: 'POST' }), b.key.jkt));
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(called).toBe(1);
    const ok = await b.get(staffHeaders(await proofOf(b.key), b.key.jkt));
    expect(ok.statusCode).toBe(200);
    expect(called).toBe(1);
  });
});

describe('DPoP 경계(offline-gate §6.1 iat ±5분·jti 10분, O-T37 ②③④⑤)', () => {
  test('O-T37 ④ 서버 시각 − iat가 +300,000ms면 통과, +300,001ms면 401이고, −300,000ms면 통과, −300,001ms면 401이다', async () => {
    // 시계를 iat보다 300,001ms 앞(증명이 미래)에서 시작해 1ms씩 경계를 넘긴다
    const b = await boot({ now: T0 - 300_001 });
    const at = async () => (await b.get(staffHeaders(await proofOf(b.key, { iat: IAT }), b.key.jkt))).statusCode;
    b.rejections.length = 0;
    expect(await at()).toBe(401); // −300,001ms
    b.clock.advance(1);
    expect(await at()).toBe(200); // −300,000ms
    b.clock.advance(600_000);
    expect(await at()).toBe(200); // +300,000ms
    b.rejections.length = 0;
    b.clock.advance(1);
    expect(await at()).toBe(401); // +300,001ms
  });

  test('O-T37 ④ 6분 어긋난 증명은 앞뒤 모두 401이고 기기 원장을 찾지 않는다', async () => {
    const b = await boot();
    const past = await b.get(staffHeaders(await proofOf(b.key, { iat: IAT - 360 }), b.key.jkt));
    const future = await b.get(staffHeaders(await proofOf(b.key, { iat: IAT + 360 }), b.key.jkt));
    expect([past.statusCode, future.statusCode]).toEqual([401, 401]);
    expect(b.devices.lookups).toBe(0);
  });

  test('O-T37 ② 같은 증명을 299초 뒤 다시 보내면 iat 창 안이어도 jti로 401이고, jti는 10분(600,000ms)으로 맡긴다', async () => {
    const b = await boot();
    const proof = await proofOf(b.key, { jti: 'f055-replay-299' });
    expect((await b.get(staffHeaders(proof, b.key.jkt))).statusCode).toBe(200);
    b.clock.advance(299_000);
    const replay = await b.get(staffHeaders(proof, b.key.jkt));
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(b.rejections).toEqual(['jti']);
    expect(b.replay.claims).toEqual([
      { jti: 'f055-replay-299', ttlMs: 600_000 },
      { jti: 'f055-replay-299', ttlMs: 600_000 },
    ]);
  });

  test('O-T37 ③ htm만 다른 증명과 htu만 다른 증명은 각각 401이다', async () => {
    const b = await boot();
    const wrongMethod = await b.get(staffHeaders(await proofOf(b.key, { htm: 'PUT' }), b.key.jkt));
    const wrongUrl = await b.get(staffHeaders(await proofOf(b.key, { htu: `https://${HOST}/v1/f055/lead` }), b.key.jkt));
    expect([wrongMethod.statusCode, wrongUrl.statusCode]).toEqual([401, 401]);
  });

  test('O-T37 ⑤ 기기 A의 토큰(X-User-Jkt=A)을 기기 B 키 증명과 보내면 ath가 맞아도 401이다 [ASVS v5.0.0-10.3.5]', async () => {
    const b = await boot();
    const deviceB = await keyOf();
    b.devices.byJkt.set(deviceB.jkt, { deviceId: 'dev-2', status: 'ACTIVE', promoterId: 'prom-1' });
    const r = await b.get(staffHeaders(await proofOf(deviceB, { ath: ATH }), b.key.jkt));
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    expect(b.sessions.calls).toBe(0);
  });
});

describe('세션 5초 캐시 경계(offline-gate §6.2, ADR-0051 결정 4, O-T21 ①)', () => {
  test('O-T21 ① 해제 전 판정 뒤 4,999ms는 같은 답으로 통과하고, 5,000ms가 되는 요청부터 다시 물어 401 invalid_token이다 [ASVS v5.0.0-7.2.1]', async () => {
    const b = await boot();
    expect((await b.get(staffHeaders(await proofOf(b.key), b.key.jkt))).statusCode).toBe(200);
    expect(b.sessions.calls).toBe(1);
    b.sessions.answer = { valid: false }; // 파트너가 배정을 해제했다
    b.clock.advance(4_999);
    const cached = await b.get(staffHeaders(await proofOf(b.key), b.key.jkt));
    expect(cached.statusCode).toBe(200);
    expect(b.sessions.calls).toBe(1);
    b.clock.advance(1);
    const asked = await b.get(staffHeaders(await proofOf(b.key), b.key.jkt));
    expect(asked.statusCode).toBe(401);
    expect(asked.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
    expect(b.sessions.calls).toBe(2);
  });

  test('O-T21 ① 무효 답도 5초 캐시하고 6초·16분 뒤에도 401이다', async () => {
    const b = await boot();
    b.sessions.answer = { valid: false };
    // 증명 iat는 그때 시각으로 만든다(iat 창이 아니라 세션 판정으로 거절되는지 본다)
    const now = async () => {
      const r = await b.get(staffHeaders(await proofOf(b.key, { iat: Math.floor(b.clock.now() / 1000) }), b.key.jkt));
      return { status: r.statusCode, error: r.headers['www-authenticate'] };
    };
    const invalid = { status: 401, error: 'DPoP error="invalid_token"' };
    expect(await now()).toEqual(invalid);
    b.clock.advance(6_000);
    expect(await now()).toEqual(invalid);
    b.clock.advance(16 * 60_000);
    expect(await now()).toEqual(invalid);
    expect(b.sessions.calls).toBe(3);
  });
});

describe('판정에 닿지 못하면 닫는다(offline-gate §6.6, 장애 주입)', () => {
  const expectUnavailable = (r: { statusCode: number; headers: Record<string, unknown>; payload: string }) => {
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('1');
    expect(problemType(r.payload)).toBe('https://peaket.example/problems/scanner-auth-unavailable');
  };

  test('O-T37 ⑨ identity가 던지면 캐시가 없을 때 503 scanner-auth-unavailable·Retry-After 1이고 이름표는 unavailable이다 [ASVS v5.0.0-7.2.1]', async () => {
    const b = await boot();
    b.sessions.fail = true;
    expectUnavailable(await b.get(staffHeaders(await proofOf(b.key), b.key.jkt)));
    expect(b.sessions.calls).toBe(1);
    expect(b.rejections).toEqual(['unavailable']);
  });

  test('O-T21 ① identity가 멈춰도 캐시 나이 4,999ms는 통과하고 5,000ms는 503이다', async () => {
    const b = await boot();
    expect((await b.get(staffHeaders(await proofOf(b.key), b.key.jkt))).statusCode).toBe(200);
    b.sessions.fail = true;
    b.clock.advance(4_999);
    expect((await b.get(staffHeaders(await proofOf(b.key), b.key.jkt))).statusCode).toBe(200);
    b.clock.advance(1);
    expectUnavailable(await b.get(staffHeaders(await proofOf(b.key), b.key.jkt)));
    expect(b.sessions.calls).toBe(2);
  });

  test('O-T37 ⑨ 기기 원장이 던지면 503이고 통과하지 않는다', async () => {
    const b = await boot();
    b.devices.fail = true;
    expectUnavailable(await b.get(staffHeaders(await proofOf(b.key), b.key.jkt)));
    expect(b.devices.lookups).toBe(1);
    expect(b.sessions.calls).toBe(0);
  });

  test('O-T37 ⑨ jti 저장소가 던지면 503이고 통과하지 않는다', async () => {
    const b = await boot();
    b.replay.fail = true;
    expectUnavailable(await b.get(staffHeaders(await proofOf(b.key), b.key.jkt)));
    expect(b.devices.lookups).toBe(0);
  });

  test('O-T37 ⑨ 마지막 연락 시각(touch)이 던져도 통과하고 이름표를 남기지 않는다', async () => {
    const b = await boot();
    b.devices.touchFails = true;
    const r = await b.get(staffHeaders(await proofOf(b.key), b.key.jkt));
    expect(r.statusCode).toBe(200);
    expect(b.devices.touched).toBe(1);
    expect(b.rejections).toEqual([]);
  });
});

describe('스캐너 쓰기 경로의 출처 확인(offline-gate §6.1 GAT-170 마감 규칙, O-T35)', () => {
  const forbidden = (origin: unknown, expected = PWA_ORIGIN) => {
    let thrown: unknown;
    try {
      assertScannerOrigin(origin, expected);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, String(origin)).toBeInstanceOf(ProblemError);
    expect({ status: (thrown as ProblemError).status, type: (thrown as ProblemError).type }, String(origin)).toEqual({
      status: 403,
      type: 'https://peaket.example/problems/scanner-origin-forbidden',
    });
  };

  test('O-T35 ① 다른 사이트·끝 슬래시·대소문자·포트·스킴만 다른 출처는 모두 403 scanner-origin-forbidden이다 [ASVS v5.0.0-3.5.1]', () => {
    for (const o of [
      'https://evil.example',
      'https://scanner.peaket.example/',
      'https://SCANNER.peaket.example',
      'https://scanner.peaket.example:443',
      'https://scanner.peaket.example:8443',
      'http://scanner.peaket.example',
      'https://scanner.peaket.example.evil.example',
      'null',
    ]) {
      forbidden(o);
    }
  });

  test('O-T35 ② Origin이 없거나 문자열이 아니면 403이다 [ASVS v5.0.0-3.5.1]', () => {
    for (const o of [undefined, '', null, ['https://scanner.peaket.example'], 0]) forbidden(o);
  });

  test('O-T35 ⑤ 기대 출처와 정확히 같은 문자열만 통과한다', () => {
    expect(() => assertScannerOrigin(PWA_ORIGIN, PWA_ORIGIN)).not.toThrow();
    expect(() => assertScannerOrigin('https://scanner.demo.localhost:8443', 'https://scanner.demo.localhost:8443')).not.toThrow();
    forbidden(PWA_ORIGIN, 'https://scanner.demo.localhost:8443');
  });

  test('O-T35 ⑤ 허용 출처 환경 변수는 PEAKET_SCANNER_PWA_ORIGIN이고, 없거나 비면 https://scanner.peaket.example이다', () => {
    expect(SCANNER_PWA_ORIGIN_ENV).toBe('PEAKET_SCANNER_PWA_ORIGIN');
    expect(scannerPwaOriginFromEnv({})).toBe('https://scanner.peaket.example');
    expect(scannerPwaOriginFromEnv({ PEAKET_SCANNER_PWA_ORIGIN: '' })).toBe('https://scanner.peaket.example');
    expect(scannerPwaOriginFromEnv({ PEAKET_SCANNER_PWA_ORIGIN: 'https://scanner.demo.localhost:8443' })).toBe('https://scanner.demo.localhost:8443');
  });
});
