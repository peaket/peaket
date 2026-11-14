// SCR-036 기기 승인 로그인 API 연결(RFC 8628) 시험.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceLoginError, enrollDevice, pollDeviceToken, startDeviceAuthorization } from '../src/api/device-login.ts';
import { generateDpopKey } from '../src/api/dpop.ts';

const ORIGIN = 'https://scanner-api.peaket.example';
const key = await generateDpopKey();

function fakeFetch(status: number, body: unknown): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

test('기기 승인 시작은 DPoP 증명과 빈 JSON 본문을 보내고 확인 코드·QR 주소를 받는다', async () => {
  const f = fakeFetch(200, {
    deviceCode: 'device-code',
    userCode: 'BCDF-GHJK',
    verificationUriComplete: 'https://scanner.peaket.example/approve#code=BCDF-GHJK',
    expiresIn: 300,
    interval: 5,
  });
  const a = await startDeviceAuthorization({ origin: ORIGIN, key, fetch: f.fetch });
  assert.equal(f.calls[0]!.url, `${ORIGIN}/v1/scanner/device-authorizations`);
  assert.equal(f.calls[0]!.init.method, 'POST');
  assert.equal(f.calls[0]!.init.body, '{}');
  assert.equal(f.calls[0]!.init.credentials, 'omit');
  const headers = f.calls[0]!.init.headers as Record<string, string>;
  assert.match(headers.dpop!, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(a, {
    deviceCode: 'device-code',
    userCode: 'BCDF-GHJK',
    verificationUriComplete: 'https://scanner.peaket.example/approve#code=BCDF-GHJK',
    expiresIn: 300,
    interval: 5,
  });
});

test('토큰 폴링은 pending·slow_down을 기다림으로, access_denied·expired_token을 끝으로 가른다', async () => {
  const pending = fakeFetch(400, { error: 'authorization_pending' });
  await assert.rejects(() => pollDeviceToken({ origin: ORIGIN, key, deviceCode: 'd', fetch: pending.fetch }), (e: unknown) => e instanceof DeviceLoginError && e.code === 'authorization_pending');

  const slow = fakeFetch(400, { error: 'slow_down', interval: 7 });
  await assert.rejects(() => pollDeviceToken({ origin: ORIGIN, key, deviceCode: 'd', fetch: slow.fetch }), (e: unknown) => e instanceof DeviceLoginError && e.code === 'slow_down' && e.intervalSec === 7);

  const denied = fakeFetch(400, { error: 'access_denied' });
  await assert.rejects(() => pollDeviceToken({ origin: ORIGIN, key, deviceCode: 'd', fetch: denied.fetch }), (e: unknown) => e instanceof DeviceLoginError && e.code === 'access_denied');

  const expired = fakeFetch(400, { error: 'expired_token' });
  await assert.rejects(() => pollDeviceToken({ origin: ORIGIN, key, deviceCode: 'd', fetch: expired.fetch }), (e: unknown) => e instanceof DeviceLoginError && e.code === 'expired_token');
});

test('승인된 토큰은 access_token·expires_in을 주고, 폐기 기기는 device_revoked로 끝난다', async () => {
  const ok = fakeFetch(200, { access_token: 'staff-token', token_type: 'DPoP', expires_in: 3600 });
  const grant = await pollDeviceToken({ origin: ORIGIN, key, deviceCode: 'd', fetch: ok.fetch });
  assert.deepEqual(grant, { accessToken: 'staff-token', expiresIn: 3600 });
  assert.equal(ok.calls[0]!.init.body, JSON.stringify({ deviceCode: 'd' }));

  const revoked = fakeFetch(403, { type: 'https://peaket.example/problems/device-revoked', title: '폐기된 스캐너 기기입니다' });
  await assert.rejects(() => pollDeviceToken({ origin: ORIGIN, key, deviceCode: 'd', fetch: revoked.fetch }), (e: unknown) => e instanceof DeviceLoginError && e.code === 'device_revoked' && e.status === 403);
});

test('기기 등록은 코드와 DPoP 증명을 보내고, 만료 코드(410)는 expired_token이다', async () => {
  const ok = fakeFetch(201, { deviceId: '0190f3a1-7c2e-7a00-8000-000000000003' });
  const r = await enrollDevice({ origin: ORIGIN, key, code: 'BCDF-GHJK-LMNP', fetch: ok.fetch });
  assert.equal(r.deviceId, '0190f3a1-7c2e-7a00-8000-000000000003');
  assert.equal(ok.calls[0]!.url, `${ORIGIN}/v1/scanner/device-enrollments`);
  assert.equal(ok.calls[0]!.init.body, JSON.stringify({ code: 'BCDF-GHJK-LMNP' }));

  const gone = fakeFetch(410, { type: 'https://peaket.example/problems/enrollment-code-expired', title: '등록 코드가 만료·사용됐습니다' });
  await assert.rejects(() => enrollDevice({ origin: ORIGIN, key, code: 'BCDF-GHJK-LMNP', fetch: gone.fetch }), (e: unknown) => e instanceof DeviceLoginError && e.code === 'expired_token' && e.status === 410);
});
