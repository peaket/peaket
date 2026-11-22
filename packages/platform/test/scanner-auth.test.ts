// 스캐너 기기 증명(DPoP)과 기기·세션 판정(GAT-170, offline-gate §6.1, RFC 9449). O-T37의 ②~⑦을 단위 시험으로 본다.
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  MemoryDpopReplayStore,
  Roles,
  ScannerAuth,
  athOf,
  createService,
  fakeClock,
  mtlsConfirmationOf,
  type DpopReplayStore,
  type FakeClock,
  type Principal,
  type ScannerAuthWiring,
  type ScannerDeviceLookup,
  type ScannerDeviceRecord,
  type ScannerMtlsOptions,
  type ScannerSessionAnswer,
  type ScannerSessionCheck,
} from '../src/index.js';
import { collector } from './fixture.js';

@Controller('v1/scanner-test')
class ScannerController {
  @Get('shift')
  @Roles(['gate_staff', 'gate_lead'])
  @ScannerAuth()
  shift(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId, tenantId: p.tenantId };
  }
}

@Controller('v1/scanner-test')
class ScannerWithoutProofController {
  @Get('shift')
  @Roles(['gate_staff', 'gate_lead'])
  shift() {
    return { ok: true };
  }
}

@Controller('v1/scanner-lead')
class LeadOnlyController {
  @Get('shift')
  @Roles(['gate_lead'])
  @ScannerAuth()
  shift() {
    return { ok: true };
  }
}

@Controller('v1/scanner-device-test')
class DeviceOnlyController {
  @Get('authorize')
  @Roles(['scanner_device'])
  @ScannerAuth({ token: 'none', device: 'registered' })
  authorize(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId, sessionId: p.sessionId, tenantId: p.tenantId };
  }
}

@Controller('v1/scanner-optional-test')
class OptionalTokenController {
  @Get('scans')
  @Roles(['scanner_device', 'gate_staff', 'gate_lead'])
  @ScannerAuth({ token: 'optional', device: 'registered' })
  scans(@CurrentPrincipal() p: Principal) {
    return { role: p.role, deviceId: p.deviceId, sessionId: p.sessionId };
  }
}

@Module({ controllers: [ScannerController] })
class ScannerModule {}

@Module({ controllers: [ScannerWithoutProofController] })
class ScannerWithoutProofModule {}

@Module({ controllers: [LeadOnlyController] })
class LeadOnlyModule {}

@Module({ controllers: [DeviceOnlyController] })
class DeviceOnlyModule {}

@Module({ controllers: [OptionalTokenController] })
class OptionalTokenModule {}

class FakeDevices implements ScannerDeviceLookup {
  readonly byJkt = new Map<string, ScannerDeviceRecord>();
  readonly touched: { deviceId: string; atMs: number }[] = [];
  async byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null> {
    return this.byJkt.get(jkt) ?? null;
  }
  async touch(deviceId: string, atMs: number): Promise<void> {
    this.touched.push({ deviceId, atMs });
  }
}

class FakeSessions implements ScannerSessionCheck {
  readonly answers = new Map<string, ScannerSessionAnswer>();
  calls = 0;
  async check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    this.calls += 1;
    return this.answers.get(`${q.scannerSessionId}/${q.deviceId}`) ?? { valid: false };
  }
}

class FakeReplay implements DpopReplayStore {
  readonly used = new Set<string>();
  async claim(jti: string): Promise<boolean> {
    if (this.used.has(jti)) return false;
    this.used.add(jti);
    return true;
  }
}

const started: Awaited<ReturnType<typeof createService>>[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

interface Booted {
  svc: Awaited<ReturnType<typeof createService>>;
  clock: FakeClock;
  devices: FakeDevices;
  sessions: FakeSessions;
  replay: FakeReplay;
  get(headers: Record<string, string>, url?: string): Promise<{ statusCode: number; headers: Record<string, unknown>; payload: string }>;
}

async function boot(module: unknown = ScannerModule, withScanner = true, mtls?: ScannerMtlsOptions, publicOrigin?: string): Promise<Booted> {
  const clock = fakeClock();
  const devices = new FakeDevices();
  const sessions = new FakeSessions();
  const replay = new FakeReplay();
  const scanner = { devices, sessions, replay, ...(mtls ? { mtls } : {}), ...(publicOrigin ? { publicOrigin } : {}) } as ScannerAuthWiring;
  const logs = collector();
  const svc = await createService({
    name: 'scanner-auth-svc',
    module: module as never,
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: logs.stream,
    ...(withScanner ? { scanner } : {}),
  });
  started.push(svc);
  return {
    svc,
    clock,
    devices,
    sessions,
    replay,
    get: (headers, url = '/v1/scanner-test/shift') => svc.http.inject({ method: 'GET', url, headers }),
  };
}

type GeneratedKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface Key {
  privateKey: GeneratedKeyPair['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

async function proofOf(
  key: Key,
  o: { jti?: string; htm?: string; htu?: string; iat?: number; ath?: string; typ?: string; jwk?: Record<string, unknown> } = {},
): Promise<string> {
  return new SignJWT({
    jti: o.jti ?? 'jti-1',
    htm: o.htm ?? 'GET',
    htu: o.htu ?? 'https://scanner-api.peaket.example/v1/scanner-test/shift',
    iat: o.iat ?? IAT,
    ath: o.ath ?? ATH,
  })
    .setProtectedHeader({ typ: o.typ ?? 'dpop+jwt', alg: 'ES256', jwk: (o.jwk ?? key.jwk) as never })
    .sign(key.privateKey);
}

const TOKEN = 'staff-access-token';
const ATH = athOf(TOKEN);
/** fakeClock의 기본 시작 시각과 같게 둔다 */
const IAT = Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000);

function headersOf(proof: string, jkt: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-user-id': 'acc-staff',
    'x-session-id': 'sess-1',
    'x-user-aud': 'scanner',
    'x-user-jkt': jkt,
    'x-user-ath': ATH,
    authorization: `DPoP ${TOKEN}`,
    dpop: proof,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'scanner-api.peaket.example',
    ...extra,
  };
}

async function ready(b: Booted, key: Key, session: ScannerSessionAnswer = { valid: true, role: 'gate_staff', eventId: 'ev-1' }): Promise<Record<string, string>> {
  b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
  b.sessions.answers.set('sess-1/dev-1', session);
  return headersOf(await proofOf(key), key.jkt);
}

describe('스캐너 기기 증명(GAT-170, O-T37)', () => {
  test('O-T37 ②~⑦ 정상 증명은_기기와세션을_판정하고_역할과기기ID를_넘긴다 [ASVS v5.0.0-10.3.5]', async () => {
    const b = await boot();
    const key = await keyOf();
    const r = await b.get(await ready(b, key));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ role: 'gate_staff', deviceId: 'dev-1', tenantId: 'prom-1' });
  });

  test('O-T37 ② 같은 jti를_다시보내면_401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    const headers = await ready(b, key);
    expect((await b.get(headers)).statusCode).toBe(200);
    const replay = await b.get(headersOf(await proofOf(key), key.jkt));
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
  });

  test('O-T37 ③ htm과 htu가다르면_401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const wrongMethod = await b.get(headersOf(await proofOf(key, { htm: 'POST' }), key.jkt));
    expect(wrongMethod.statusCode).toBe(401);
    const wrongUrl = await b.get(headersOf(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/other' }), key.jkt));
    expect(wrongUrl.statusCode).toBe(401);
  });

  test('DPoP htu의 호스트가 다르면 401이고, 같은 호스트의 질의 문자열은 통과한다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const evil = await b.get(headersOf(await proofOf(key, { htu: 'https://evil.example/v1/scanner-test/shift' }), key.jkt));
    expect(evil.statusCode).toBe(401);
    expect(evil.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    const query = await b.get(headersOf(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-test/shift?after=1', jti: 'jti-query' }), key.jkt));
    expect(query.statusCode).toBe(200);
  });

  test('C2-09 공개 출처가 있으면 forwarded-host를 위조해도 htu는 공개 출처로 견준다', async () => {
    const b = await boot(ScannerModule, true, undefined, 'https://scanner-api.peaket.example');
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const forged = await b.get(headersOf(await proofOf(key), key.jkt, { 'x-forwarded-host': 'evil.example' }));
    expect(forged.statusCode).toBe(200);
    const wrong = await b.get(
      headersOf(await proofOf(key, { htu: 'https://evil.example/v1/scanner-test/shift', jti: 'htu-forged' }), key.jkt, { 'x-forwarded-host': 'evil.example' }),
    );
    expect(wrong.statusCode).toBe(401);
  });

  test('DPoP typ가 dpop+jwt가 아니거나 헤더 jwk에 개인키 d가 있으면 401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const wrongTyp = await b.get(headersOf(await proofOf(key, { typ: 'jwt' }), key.jkt));
    expect(wrongTyp.statusCode).toBe(401);
    const privateJwk = await b.get(headersOf(await proofOf(key, { jwk: { ...key.jwk, d: 'private' }, jti: 'jti-private' }), key.jkt));
    expect(privateJwk.statusCode).toBe(401);
  });

  test('세션 판정이 valid:false인데 역할·회차가 붙어 있어도 401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    const headers = await ready(b, key, { valid: false, role: 'gate_staff', eventId: 'ev-1' });
    const r = await b.get(headers);
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
  });

  test('O-T37 ④ iat가 6분 어긋나면 401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const old = await b.get(headersOf(await proofOf(key, { iat: IAT - 6 * 60 }), key.jkt));
    expect(old.statusCode).toBe(401);
  });

  test('I-T39 ① O-T37 ⑤ ath와 cnf.jkt가 다르면 401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const wrongAth = await b.get(headersOf(await proofOf(key, { ath: athOf('other-token') }), key.jkt));
    expect(wrongAth.statusCode).toBe(401);
    const wrongJkt = await b.get(headersOf(await proofOf(key, { jti: 'jti-cnf' }), 'another-jkt'));
    expect(wrongJkt.statusCode).toBe(401);
  });

  test('O-T37 ⑥⑦ 미등록 기기와 폐기 기기는 403이다', async () => {
    const b = await boot();
    const key = await keyOf();
    const unregistered = await b.get(headersOf(await proofOf(key), key.jkt));
    expect(unregistered.statusCode).toBe(403);
    expect(JSON.parse(unregistered.payload)).toMatchObject({ type: 'https://peaket.example/problems/device-unregistered' });
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'REVOKED', promoterId: 'prom-1' });
    const revoked = await b.get(headersOf(await proofOf(key, { jti: 'jti-revoked' }), key.jkt));
    expect(revoked.statusCode).toBe(403);
    expect(JSON.parse(revoked.payload)).toMatchObject({ type: 'https://peaket.example/problems/device-revoked' });
  });

  test('I-T25 ③ O-T37 세션이 무효이면 401이고 gate_staff가 gate_lead 전용 처리기를 부르면 403이다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: false });
    const invalid = await b.get(headersOf(await proofOf(key), key.jkt));
    expect(invalid.statusCode).toBe(401);

    // gate_staff 세션으로 gate_lead 전용 처리기를 부르면 403이다(대리 승인은 gate_staff로 낮춘다, ADR-0172)
    const lead = await boot(LeadOnlyModule);
    lead.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    lead.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const forbidden = await lead.get(headersOf(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-lead/shift' }), key.jkt), '/v1/scanner-lead/shift');
    expect(forbidden.statusCode).toBe(403);
  });

  test('O-T37 세션 판정은 5초 캐시하고 6초 뒤에는 다시 묻는다', async () => {
    const b = await boot();
    const key = await keyOf();
    const first = await b.get(await ready(b, key));
    expect(first.statusCode).toBe(200);
    const second = await b.get(headersOf(await proofOf(key, { jti: 'jti-2' }), key.jkt));
    expect(second.statusCode).toBe(200);
    expect(b.sessions.calls).toBe(1);
    b.clock.advance(6_000);
    const third = await b.get(headersOf(await proofOf(key, { jti: 'jti-3' }), key.jkt));
    expect(third.statusCode).toBe(200);
    expect(b.sessions.calls).toBe(2);
  });
});

describe('스캐너 mTLS 선택지 PoC(GAT-170, BAT-435)', () => {
  const X5T = 'X'.repeat(43);
  const MTLS: ScannerMtlsOptions = { secret: 'gw-secret' };
  const mtlsHeaders = (over: Record<string, string | undefined> = {}): Record<string, string> => {
    const base: Record<string, string | undefined> = {
      'x-user-id': 'acc-staff',
      'x-session-id': 'sess-1',
      'x-user-aud': 'scanner',
      authorization: `DPoP ${TOKEN}`,
      'x-peaket-mtls-authenticated': 'gw-secret',
      'x-peaket-client-cert-sha256': X5T,
      'x-user-x5t': X5T,
      ...over,
    };
    return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
  };

  test('게이트웨이 비밀·인증서 지문·토큰 cnf.x5t#S256이 같으면 DPoP 증명 없이 통과한다', async () => {
    const b = await boot(ScannerModule, true, MTLS);
    b.devices.byJkt.set(X5T, { deviceId: 'dev-mtls', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-mtls', { valid: true, role: 'gate_lead', eventId: 'ev-1' });
    const r = await b.get(mtlsHeaders());
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ role: 'gate_lead', deviceId: 'dev-mtls', tenantId: 'prom-1' });
  });

  test('기기 인증만 하는 경로는 mTLS 인증서 지문만으로 통과하고 cnf.x5t를 요구하지 않는다', async () => {
    const b = await boot(DeviceOnlyModule, true, MTLS);
    b.devices.byJkt.set(X5T, { deviceId: 'dev-mtls', status: 'ACTIVE', promoterId: 'prom-1' });
    const r = await b.get({ 'x-peaket-mtls-authenticated': 'gw-secret', 'x-peaket-client-cert-sha256': X5T }, '/v1/scanner-device-test/authorize');
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ role: 'scanner_device', deviceId: 'dev-mtls', sessionId: '', tenantId: 'prom-1' });
  });

  test('자체 서명 인증서 DER의 x5t#S256로도 가드가 기기를 찾는다', async () => {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'scanner-poc' }], { keySize: 2048 });
    const x5t = mtlsConfirmationOf(new X509Certificate(pems.cert).raw);
    const b = await boot(ScannerModule, true, MTLS);
    b.devices.byJkt.set(x5t, { deviceId: 'dev-cert', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-cert', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const r = await b.get(mtlsHeaders({ 'x-peaket-client-cert-sha256': x5t, 'x-user-x5t': x5t }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ deviceId: 'dev-cert' });
  });

  test('비밀 값이 틀리거나 인증서 지문과 토큰 cnf가 다르거나 인증서 머리가 없으면 401이다', async () => {
    const b = await boot(ScannerModule, true, MTLS);
    b.devices.byJkt.set(X5T, { deviceId: 'dev-mtls', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-mtls', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    expect((await b.get(mtlsHeaders({ 'x-peaket-mtls-authenticated': 'wrong' }))).statusCode).toBe(401);
    expect((await b.get(mtlsHeaders({ 'x-user-x5t': 'Y'.repeat(43) }))).statusCode).toBe(401);
    expect((await b.get(mtlsHeaders({ 'x-peaket-client-cert-sha256': undefined }))).statusCode).toBe(401);
  });

  test('폐기된 인증서 기기는 403이고, mTLS 머리가 없으면 기존 DPoP 경로를 그대로 쓴다', async () => {
    const b = await boot(ScannerModule, true, MTLS);
    b.devices.byJkt.set(X5T, { deviceId: 'dev-mtls', status: 'REVOKED', promoterId: 'prom-1' });
    const revoked = await b.get(mtlsHeaders());
    expect(revoked.statusCode).toBe(403);
    expect(JSON.parse(revoked.payload)).toMatchObject({ type: 'https://peaket.example/problems/device-revoked' });

    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const dpop = await b.get(headersOf(await proofOf(key), key.jkt));
    expect(dpop.statusCode).toBe(200);
  });

  test('wiring.mtls가 없으면 mTLS 머리를 믿지 않고 DPoP 증명을 요구한다', async () => {
    const b = await boot();
    b.devices.byJkt.set(X5T, { deviceId: 'dev-mtls', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-mtls', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const r = await b.get(mtlsHeaders());
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_token"');
  });
});

describe('스캐너 인증 시작 확인(GAT-170)', () => {
  test('스캐너포트가없으면_스캐너역할처리기가_시작하지않는다', async () => {
    await expect(boot(ScannerModule, false)).rejects.toThrow(/gate_staff/);
  });

  test('스캐너역할에_ScannerAuth가없으면_시작하지않는다', async () => {
    await expect(boot(ScannerWithoutProofModule)).rejects.toThrow(/ScannerAuth/);
  });

  test('스캐너포트와_ScannerAuth가있으면_시작한다', async () => {
    const b = await boot();
    expect(b.svc.name).toBe('scanner-auth-svc');
  });
});


describe('기기 증명만 하는 스캐너 경로(GAT-220, I-T22)', () => {
  const deviceHeaders = (proof: string) => ({
    dpop: proof,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'scanner-api.peaket.example',
  });

  test('기기 키 증명만으로_기기ID와파트너를넘기고_사람토큰은받지않는다', async () => {
    const b = await boot(DeviceOnlyModule);
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    const r = await b.get(deviceHeaders(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-device-test/authorize' })), '/v1/scanner-device-test/authorize');
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ role: 'scanner_device', deviceId: 'dev-1', sessionId: '', tenantId: 'prom-1' });
    expect(b.devices.touched).toEqual([{ deviceId: 'dev-1', atMs: b.clock.now() }]);
  });

  test('기기 전용 경로에_사용자토큰을붙이면_401이다', async () => {
    const b = await boot(DeviceOnlyModule);
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    const proof = await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-device-test/authorize' });
    const r = await b.get({ ...deviceHeaders(proof), authorization: `DPoP ${TOKEN}` }, '/v1/scanner-device-test/authorize');
    expect(r.statusCode).toBe(401);
  });

  test('미등록·폐기 기기는_403이다', async () => {
    const b = await boot(DeviceOnlyModule);
    const key = await keyOf();
    const unregistered = await b.get(deviceHeaders(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-device-test/authorize' })), '/v1/scanner-device-test/authorize');
    expect(unregistered.statusCode).toBe(403);
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'REVOKED', promoterId: 'prom-1' });
    const revoked = await b.get(deviceHeaders(await proofOf(key, { jti: 'jti-revoked', htu: 'https://scanner-api.peaket.example/v1/scanner-device-test/authorize' })), '/v1/scanner-device-test/authorize');
    expect(revoked.statusCode).toBe(403);
    expect(JSON.parse(revoked.payload)).toMatchObject({ type: 'https://peaket.example/problems/device-revoked' });
  });

  test('토큰이 선택인 경로는_없으면기기로_있으면세션으로판정한다', async () => {
    const b = await boot(OptionalTokenModule);
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    const deviceOnly = await b.get(deviceHeaders(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-optional-test/scans' })), '/v1/scanner-optional-test/scans');
    expect(deviceOnly.statusCode).toBe(200);
    expect(JSON.parse(deviceOnly.payload)).toEqual({ role: 'scanner_device', deviceId: 'dev-1', sessionId: '' });

    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const withToken = await b.get(
      headersOf(await proofOf(key, { jti: 'jti-2', htu: 'https://scanner-api.peaket.example/v1/scanner-optional-test/scans' }), key.jkt),
      '/v1/scanner-optional-test/scans',
    );
    expect(withToken.statusCode).toBe(200);
    expect(JSON.parse(withToken.payload)).toEqual({ role: 'gate_staff', deviceId: 'dev-1', sessionId: 'sess-1' });
  });
});

describe('R-622 M5-02·M5-04·M5-05·M5-06 DPoP·가드 정본 계약', () => {
  const setup = async (): Promise<{ b: Booted; key: Key }> => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    return { b, key };
  };

  test('htu는 호스트·스킴·포트·사용자정보까지 같아야 하고, 같은 주소의 질의·조각은 무시한다', async () => {
    const { b, key } = await setup();
    const wrong = [
      { htu: 'https://evil.example/v1/scanner-test/shift', jti: 'htu-host' },
      { htu: 'http://scanner-api.peaket.example/v1/scanner-test/shift', jti: 'htu-scheme' },
      { htu: 'https://scanner-api.peaket.example:8443/v1/scanner-test/shift', jti: 'htu-port' },
      { htu: 'https://scanner-api.peaket.example@evil.example/v1/scanner-test/shift', jti: 'htu-userinfo' },
      { htu: 'https://scanner-api.peaket.example/v1/scanner-test/shift/', jti: 'htu-slash' },
    ];
    for (const c of wrong) {
      const r = await b.get(headersOf(await proofOf(key, c), key.jkt));
      expect(r.statusCode, c.jti).toBe(401);
      expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    }
    const query = await b.get(
      headersOf(await proofOf(key, { htu: 'https://scanner-api.peaket.example/v1/scanner-test/shift?after=1#top', jti: 'htu-query' }), key.jkt),
    );
    expect(query.statusCode).toBe(200);
  });

  test('typ가 dpop+jwt가 아닌 증명은 JWT·소문자·빈 값 모두 401이다', async () => {
    const { b, key } = await setup();
    for (const [i, typ] of ['JWT', 'dpop', ''].entries()) {
      const r = await b.get(headersOf(await proofOf(key, { typ, jti: `typ-${i}` }), key.jkt));
      expect(r.statusCode, typ).toBe(401);
      expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_dpop_proof"');
    }
  });

  test('헤더 jwk에 개인키 d·비EC 키·좌표 누락이 있으면 401이다', async () => {
    const { b, key } = await setup();
    const privateJwk = await b.get(headersOf(await proofOf(key, { jwk: { ...key.jwk, d: 'private' }, jti: 'jwk-d' }), key.jkt));
    expect(privateJwk.statusCode).toBe(401);

    const missingY = await b.get(headersOf(await proofOf(key, { jwk: { kty: 'EC', crv: 'P-256', x: key.jwk.x }, jti: 'jwk-no-y' }), key.jkt));
    expect(missingY.statusCode).toBe(401);

    // 서명은 EC P-256으로 맞지만 헤더 jwk의 종류·곡선이 다르면 jwk 검사에서 401이다.
    const nonEc = await b.get(headersOf(await proofOf(key, { jwk: { ...key.jwk, kty: 'RSA' }, jti: 'jwk-rsa' }), key.jkt));
    expect(nonEc.statusCode).toBe(401);
    const wrongCurve = await b.get(headersOf(await proofOf(key, { jwk: { ...key.jwk, crv: 'P-384' }, jti: 'jwk-p384' }), key.jkt));
    expect(wrongCurve.statusCode).toBe(401);
  });

  test('세션 판정이 valid:false면 역할·회차·유효 창이 함께 와도 401이고, valid:true라도 역할이 없으면 401이다', async () => {
    const invalid = await boot();
    const key = await keyOf();
    invalid.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    invalid.sessions.answers.set('sess-1/dev-1', {
      valid: false,
      role: 'gate_lead',
      eventId: 'ev-1',
      assignmentId: 'a-1',
      validFromMs: Date.parse('2026-10-31T00:00:00.000Z'),
      validUntilMs: Date.parse('2026-11-02T00:00:00.000Z'),
      proxy: false,
    });
    const r = await invalid.get(headersOf(await proofOf(key), key.jkt));
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('DPoP error="invalid_token"');

    const roleless = await boot();
    const key2 = await keyOf();
    roleless.devices.byJkt.set(key2.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    roleless.sessions.answers.set('sess-1/dev-1', { valid: true, eventId: 'ev-1' });
    expect((await roleless.get(headersOf(await proofOf(key2), key2.jkt))).statusCode).toBe(401);
  });
});
