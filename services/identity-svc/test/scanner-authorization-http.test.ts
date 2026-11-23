// Device authorization HTTP path tests (GAT-220): device DPoP only, Origin, JSON body, pending errors.
import 'reflect-metadata';
import { createService, fakeClock, SCANNER_PWA_ORIGIN_ENV as PLATFORM_SCANNER_PWA_ORIGIN_ENV, type DpopReplayStore } from '@peaket/platform';
import { SCANNER_PWA_ORIGIN_ENV } from '../src/modules/session/inbound/scanner-authorization.controller.js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JoseTokenSigner, TokenKeyRing, MemoryDeviceAuthorizations, MemoryDeviceApprovalLimits } from '../src/modules/session/index.js';
import type { DeviceAuthorizationStore, ScannerDeviceLookupAnswer, ScannerDeviceRegistry } from '../src/modules/session/domain/ports.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const ORIGIN = 'https://scanner.peaket.example';
const clock = fakeClock({ now: Date.parse('2026-11-14T03:00:00Z') });

class FakeRegistry implements ScannerDeviceRegistry {
  answer: ScannerDeviceLookupAnswer = { found: true, deviceId: '0190f3a1-7c2e-7a00-8000-000000000006', status: 'ACTIVE', name: 'gate-03', promoterId: '0190f3a1-7c2e-7a00-8000-000000000007' };
  async byThumbprint(): Promise<ScannerDeviceLookupAnswer> {
    return this.answer;
  }
}

class Replay implements DpopReplayStore {
  async claim(): Promise<boolean> {
    return true;
  }
}

let svc: Awaited<ReturnType<typeof createService>>;
let proofKey: Awaited<ReturnType<typeof generateKeyPair>>;
let proofJwk: Record<string, unknown>;

async function boot(store?: DeviceAuthorizationStore, extraEnv: Record<string, string> = {}) {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  return createService({
    name: 'identity-svc',
    module: AppModule.register({
      memory: true,
      session: {
        signer: new JoseTokenSigner(keys, ISSUER),
        keys,
        deviceRefs: testDeviceRefs(),
        signals: recordingSignals(),
        scannerDevices: new FakeRegistry(),
        deviceAuthorizations: store ?? new MemoryDeviceAuthorizations(() => clock.now()),
        deviceApprovalLimits: new MemoryDeviceApprovalLimits(),
        scannerDpopReplay: new Replay(),
      },
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) },
    }),
    env: { PEAKET_ENV: 'ci', ...extraEnv },
    clock,
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  proofKey = pair;
  proofJwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  svc = await boot();
});
afterAll(async () => {
  await svc?.close();
});

async function proof(htm: string, htu: string, jti = 'jti-1'): Promise<string> {
  return new SignJWT({ jti, htm, htu, iat: Math.floor(clock.now() / 1000) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: proofJwk as never })
    .sign(proofKey.privateKey);
}

const url = (path: string) => `https://scanner-api.peaket.example${path}`;
const baseHeaders = () => ({ origin: ORIGIN, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scanner-api.peaket.example', 'content-type': 'application/json' });

describe('device authorization HTTP [GAT-220]', () => {
  test('returns a device code with DPoP proof and scanner Origin', async () => {
    const r = await svc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-authorizations',
      headers: { ...baseHeaders(), dpop: await proof('POST', url('/v1/scanner/device-authorizations')) },
      payload: '{}',
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ expiresIn: 300, interval: 5 });
    expect(JSON.parse(r.payload).userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  });

  test('rejects a wrong Origin and a missing proof', async () => {
    const wrongOrigin = await svc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-authorizations',
      headers: { ...baseHeaders(), origin: 'https://evil.example', dpop: await proof('POST', url('/v1/scanner/device-authorizations'), 'jti-2') },
      payload: '{}',
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const noProof = await svc.http.inject({ method: 'POST', url: '/v1/scanner/device-authorizations', headers: baseHeaders(), payload: '{}' });
    expect(noProof.statusCode).toBe(400);
    expect(JSON.parse(noProof.payload)).toMatchObject({ type: 'https://peaket.example/problems/invalid-dpop-proof' });
  });

  test('C2-09 공개 출처가 있으면 forwarded-host를 위조해도 htu는 공개 출처로 견준다', async () => {
    process.env.PEAKET_PUBLIC_ORIGIN = 'https://scanner-api.peaket.example';
    try {
      const forged = await svc.http.inject({
        method: 'POST',
        url: '/v1/scanner/device-authorizations',
        headers: {
          ...baseHeaders(),
          'x-forwarded-host': 'evil.example',
          dpop: await proof('POST', url('/v1/scanner/device-authorizations'), 'c2-09-ok'),
        },
        payload: '{}',
      });
      expect(forged.statusCode).toBe(200);
      const wrong = await svc.http.inject({
        method: 'POST',
        url: '/v1/scanner/device-authorizations',
        headers: {
          ...baseHeaders(),
          'x-forwarded-host': 'evil.example',
          dpop: await proof('POST', 'https://evil.example/v1/scanner/device-authorizations', 'c2-09-bad'),
        },
        payload: '{}',
      });
      expect(wrong.statusCode).toBe(400);
    } finally {
      delete process.env.PEAKET_PUBLIC_ORIGIN;
    }
  });

  test('C2-06 ③ 사용자 코드를 잡지 못하면 409 user-code-unavailable로 다시 받게 한다', async () => {
    const failing = {
      save: async () => false,
      findByUserCode: async () => null,
      get: async () => null,
      approve: async () => false,
      deny: async () => false,
      notePoll: async () => ({ result: 'EXPIRED' }),
    } as unknown as DeviceAuthorizationStore;
    const other = await boot(failing);
    try {
      const r = await other.http.inject({
        method: 'POST',
        url: '/v1/scanner/device-authorizations',
        headers: { ...baseHeaders(), dpop: await proof('POST', url('/v1/scanner/device-authorizations'), 'c2-06-409') },
        payload: '{}',
      });
      expect(r.statusCode).toBe(409);
      expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/user-code-unavailable' });
    } finally {
      await other.close();
    }
  });

  test('returns authorization_pending before approval', async () => {
    const start = await svc.http.inject({
      method: 'POST',
      url: '/v1/scanner/device-authorizations',
      headers: { ...baseHeaders(), dpop: await proof('POST', url('/v1/scanner/device-authorizations'), 'jti-3') },
      payload: '{}',
    });
    const { deviceCode } = JSON.parse(start.payload) as { deviceCode: string };
    const r = await svc.http.inject({
      method: 'POST',
      url: '/v1/scanner/token',
      headers: { ...baseHeaders(), dpop: await proof('POST', url('/v1/scanner/token'), 'jti-4') },
      payload: JSON.stringify({ deviceCode }),
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({ error: 'authorization_pending' });
  });
});

/** 저장 호출을 세는 기기 승인 저장소(진짜 메모리 저장소에 그대로 맡기는 포트 구현) */
class CountingAuthorizations implements DeviceAuthorizationStore {
  saves = 0;
  polls = 0;
  readonly #inner = new MemoryDeviceAuthorizations(() => clock.now());
  save(r: Parameters<DeviceAuthorizationStore['save']>[0]) {
    this.saves += 1;
    return this.#inner.save(r);
  }
  findByUserCode(c: string) {
    return this.#inner.findByUserCode(c);
  }
  get(h: string) {
    return this.#inner.get(h);
  }
  approve(i: Parameters<DeviceAuthorizationStore['approve']>[0]) {
    return this.#inner.approve(i);
  }
  deny(h: string, n: number) {
    return this.#inner.deny(h, n);
  }
  notePoll(h: string, n: number) {
    this.polls += 1;
    return this.#inner.notePoll(h, n);
  }
}

describe('기기 승인 요청·토큰의 출처·JSON 확인(O-T35, offline-gate §6.1)', () => {
  let counted: CountingAuthorizations;
  let s: Awaited<ReturnType<typeof createService>>;
  let n = 0;
  const jti = () => `ot35-${++n}`;
  beforeAll(async () => {
    counted = new CountingAuthorizations();
    s = await boot(counted);
  });
  afterAll(async () => {
    await s?.close();
  });
  const send = async (path: string, o: { origin?: string | null; contentType?: string; payload?: string } = {}) => {
    const headers: Record<string, string> = {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'scanner-api.peaket.example',
      'content-type': o.contentType ?? 'application/json',
      dpop: await proof('POST', url(path), jti()),
    };
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    return s.http.inject({ method: 'POST', url: path, headers, payload: o.payload ?? '{}' });
  };
  const forbidden = (r: { statusCode: number; payload: string }, what: string) => {
    expect(r.statusCode, what).toBe(403);
    expect(JSON.parse(r.payload).type, what).toBe('https://peaket.example/problems/scanner-origin-forbidden');
  };

  test('O-T35 ① 다른 사이트·PWA와 조금 다른 Origin은 승인 요청·토큰 모두 403이고 확인 코드가 만들어지지 않는다 [ASVS v5.0.0-3.5.1]', async () => {
    for (const origin of ['https://evil.example', 'https://scanner.peaket.example/', 'https://SCANNER.peaket.example', 'https://scanner.peaket.example:8443', 'null']) {
      forbidden(await send('/v1/scanner/device-authorizations', { origin }), `승인 요청 ${origin}`);
      forbidden(await send('/v1/scanner/token', { origin, payload: JSON.stringify({ deviceCode: 'x'.repeat(43) }) }), `토큰 ${origin}`);
    }
    expect(counted.saves).toBe(0);
    expect(counted.polls).toBe(0);
  });

  test('O-T35 ② Origin이 없으면 승인 요청·토큰 모두 403이고 확인 코드가 만들어지지 않는다 [ASVS v5.0.0-3.5.1]', async () => {
    forbidden(await send('/v1/scanner/device-authorizations', { origin: null }), '승인 요청');
    forbidden(await send('/v1/scanner/token', { origin: null, payload: JSON.stringify({ deviceCode: 'x'.repeat(43) }) }), '토큰');
    expect(counted.saves).toBe(0);
    expect(counted.polls).toBe(0);
  });

  test('O-T35 ③ 양식·text/plain 본문은 PWA 출처여도 415이고 확인 코드가 만들어지지 않는다 [ASVS v5.0.0-3.5.2]', async () => {
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
      expect((await send('/v1/scanner/device-authorizations', { contentType, payload: contentType === 'text/plain' ? '{}' : 'a=1' })).statusCode, contentType).toBe(415);
      expect((await send('/v1/scanner/token', { contentType, payload: contentType === 'text/plain' ? '{"deviceCode":"x"}' : 'deviceCode=x' })).statusCode, contentType).toBe(415);
    }
    expect(counted.saves).toBe(0);
    expect(counted.polls).toBe(0);
  });

  test('O-T35 ④ PWA 출처와 빈 객체 {}의 승인 요청은 200이고 확인 코드가 하나 만들어진다', async () => {
    const r = await send('/v1/scanner/device-authorizations');
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ expiresIn: 300, interval: 5 });
    expect(counted.saves).toBe(1);
  });

  test('O-T35 ⑤ PWA 출처와 정상 본문의 토큰 요청은 처리된다(승인 전이면 authorization_pending)', async () => {
    const started = JSON.parse((await send('/v1/scanner/device-authorizations')).payload) as { deviceCode: string };
    const r = await send('/v1/scanner/token', { payload: JSON.stringify({ deviceCode: started.deviceCode }) });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({ error: 'authorization_pending' });
    expect(counted.polls).toBe(1);
  });
});

describe('허용 출처는 platform의 같은 규칙이다(offline-gate §6.1 GAT-170 마감 규칙)', () => {
  test('O-T35 ⑤ identity의 SCANNER_PWA_ORIGIN_ENV는 platform 것과 같은 PEAKET_SCANNER_PWA_ORIGIN이다', () => {
    expect(SCANNER_PWA_ORIGIN_ENV).toBe('PEAKET_SCANNER_PWA_ORIGIN');
    expect(PLATFORM_SCANNER_PWA_ORIGIN_ENV).toBe(SCANNER_PWA_ORIGIN_ENV);
  });

  test('O-T35 ⑤ PEAKET_SCANNER_PWA_ORIGIN이 있으면 그 출처만 통과하고 기본 출처는 403이다 [ASVS v5.0.0-3.5.1]', async () => {
    const custom = 'https://scanner.demo.localhost:8443';
    // 프로세스 환경과 서비스 환경 둘 다에 준다(구현이 어느 쪽에서 읽어도 같은 값)
    vi.stubEnv('PEAKET_SCANNER_PWA_ORIGIN', custom);
    const s = await boot(undefined, { PEAKET_SCANNER_PWA_ORIGIN: custom });
    try {
      const at = async (origin: string, id: string) =>
        s.http.inject({
          method: 'POST',
          url: '/v1/scanner/device-authorizations',
          headers: { ...baseHeaders(), origin, dpop: await proof('POST', url('/v1/scanner/device-authorizations'), id) },
          payload: '{}',
        });
      const def = await at(ORIGIN, 'env-default');
      expect(def.statusCode).toBe(403);
      expect(JSON.parse(def.payload).type).toBe('https://peaket.example/problems/scanner-origin-forbidden');
      expect((await at(custom, 'env-custom')).statusCode).toBe(200);
    } finally {
      await s.close();
      vi.unstubAllEnvs();
    }
  });
});
