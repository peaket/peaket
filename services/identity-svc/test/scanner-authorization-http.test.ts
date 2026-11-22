// Device authorization HTTP path tests (GAT-220): device DPoP only, Origin, JSON body, pending errors.
import 'reflect-metadata';
import { createService, fakeClock, type DpopReplayStore } from '@peaket/platform';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

async function boot(store?: DeviceAuthorizationStore) {
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
    env: { PEAKET_ENV: 'ci' },
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
