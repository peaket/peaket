// 스캐너 기기 증명(DPoP)과 기기·세션 판정(GAT-170, offline-gate §6.1, RFC 9449). O-T37의 ②~⑦을 단위 시험으로 본다.
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  MemoryDpopReplayStore,
  Roles,
  ScannerAuth,
  athOf,
  createService,
  fakeClock,
  type DpopReplayStore,
  type FakeClock,
  type Principal,
  type ScannerAuthWiring,
  type ScannerDeviceLookup,
  type ScannerDeviceRecord,
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

@Module({ controllers: [ScannerController] })
class ScannerModule {}

@Module({ controllers: [ScannerWithoutProofController] })
class ScannerWithoutProofModule {}

@Module({ controllers: [LeadOnlyController] })
class LeadOnlyModule {}

class FakeDevices implements ScannerDeviceLookup {
  readonly byJkt = new Map<string, ScannerDeviceRecord>();
  async byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null> {
    return this.byJkt.get(jkt) ?? null;
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

async function boot(module: unknown = ScannerModule, withScanner = true): Promise<Booted> {
  const clock = fakeClock();
  const devices = new FakeDevices();
  const sessions = new FakeSessions();
  const replay = new FakeReplay();
  const scanner: ScannerAuthWiring = { devices, sessions, replay };
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
  o: { jti?: string; htm?: string; htu?: string; iat?: number; ath?: string } = {},
): Promise<string> {
  return new SignJWT({
    jti: o.jti ?? 'jti-1',
    htm: o.htm ?? 'GET',
    htu: o.htu ?? 'https://scanner-api.peaket.example/v1/scanner-test/shift',
    iat: o.iat ?? IAT,
    ath: o.ath ?? ATH,
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
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

  test('O-T37 ④ iat가 6분 어긋나면 401이다', async () => {
    const b = await boot();
    const key = await keyOf();
    b.devices.byJkt.set(key.jkt, { deviceId: 'dev-1', status: 'ACTIVE', promoterId: 'prom-1' });
    b.sessions.answers.set('sess-1/dev-1', { valid: true, role: 'gate_staff', eventId: 'ev-1' });
    const old = await b.get(headersOf(await proofOf(key, { iat: IAT - 6 * 60 }), key.jkt));
    expect(old.statusCode).toBe(401);
  });

  test('O-T37 ⑤ ath와 cnf.jkt가 다르면 401이다', async () => {
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

  test('O-T37 세션이 무효이면 401이고 허용 역할이 다르면 403이다', async () => {
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
