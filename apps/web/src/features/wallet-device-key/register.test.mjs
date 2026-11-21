// 월렛 기기 키 서버 등록과 실패 처리 시험(BAT-350, GAT-010, O-T44, ADR-0336).
// 정본: docs/features/offline-gate.md §2 '서버 등록 잇기'·§11 O-T44, docs/frontend.md §4.2.4 '입장용 휴대폰 등록 세부'·§4.1 '시간 초과'(쓰기 15초),
// docs/design/d5-screen-blueprint.md §5.13('등록 확인 전'·'다시 확인 필요'·'등록 거절'), openapi createTicketDeviceKey.
// - 바꿔 끼우는 것은 팬 API 경계(globalThis.fetch)와 IndexedDB(fake-indexeddb)뿐이다. 등록 흐름(enrollment.ts·register.ts)과 저장소(store.ts)는 진짜다.
// - 가짜 서버의 keyId는 구현 코드를 쓰지 않고 정본의 식(공개키 SPKI DER의 SHA-256 앞 8바이트, base64url)을 node:crypto로 따로 계산한다.
// - 'QR을 보인다'는 등록 흐름이 화면에 주는 상태가 phase 'ready'인 것으로 본다(BAT-350 계획 §6, ui/DeviceQr는 ready일 때만 그린다).
//   화면 글·online 사건은 웨이브 끝 브라우저 확인이 본다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { CreateTicketDeviceKeyBody, CreateTicketDeviceKeyResponse } from '@peaket/contracts/openapi/tickets';
import { ORIGINS } from '../../shared/config/origins.ts';
import { signQrV1 } from './device-key.ts';
import { enrollDeviceKey, syncDeviceKeyRegistration } from './enrollment.ts';
import { keyIdFromBase64Url, qrV1Message } from './qr-v1.ts';
import { deviceKeyRegistrationAvailable, registerDeviceKey } from './register.ts';
import { loadDeviceKey, walletDatabase } from './store.ts';

/** 시험용 팬 API 출처(코드의 기본값과 다르게 골라, 부를 때마다 ORIGINS.api를 읽는지도 본다) */
const API = 'https://api.bat350.test';
/** openapi createTicketDeviceKey requestBody.publicKeyJwk.properties */
const CONTRACT_JWK_FIELDS = ['alg', 'crv', 'ext', 'key_ops', 'kty', 'x', 'y'];
const PROBLEM = 'https://peaket.example/problems/';

let n = 0;
/** 시험마다 새 티켓(UUIDv7 꼴. QR v1이 16바이트로 싣는다) */
const nextTicket = () => `0190f3a1-7c2e-7a00-8000-${String(350_000 + n++).padStart(12, '0')}`;

/** 정본의 keyId 식: 공개키 SPKI DER의 SHA-256 앞 8바이트(base64url 11자, offline-gate §2·§3) */
function keyIdOfJwk(jwk) {
  const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest().subarray(0, 8).toString('base64url');
}

/** keyId 첫 바이트를 뒤집은 다른 keyId */
function otherKeyId(keyId) {
  const b = Buffer.from(keyId, 'base64url');
  b[0] ^= 0xff;
  return b.toString('base64url');
}

const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, name, title = '오류') => json(status, { type: `${PROBLEM}${name}`, title, status }, 'application/problem+json');

/** 응답 만들기(가짜 서버가 차례대로 쓴다) */
const reply = {
  /** 201 + 받은 공개키의 keyId(진짜 서버와 같은 식) */
  created: (call) => json(201, CreateTicketDeviceKeyResponse.parse({ keyId: keyIdOfJwk(call.body.publicKeyJwk) })),
  /** 201인데 다른 keyId */
  createdOther: (call) => json(201, CreateTicketDeviceKeyResponse.parse({ keyId: otherKeyId(keyIdOfJwk(call.body.publicKeyJwk)) })),
  /** 201인데 keyId가 없다 */
  createdEmpty: () => json(201, {}),
  disconnect: () => {
    throw new TypeError('fetch failed');
  },
  /** fetch는 시간 초과 신호로 끊기면 신호의 사유(TimeoutError)로 거절한다 */
  timeout: () => {
    throw new DOMException('시간 초과', 'TimeoutError');
  },
  status: (s, name) => () => (name ? problem(s, name) : new Response(null, { status: s })),
  unauthorized: () => json(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, 'application/problem+json'),
  refreshed: () => new Response(null, { status: 204 }),
};

/**
 * 가짜 팬 API(gw-fan → ticket-svc·identity-svc 경계). 경로별로 준 응답을 차례대로 쓰고 요청을 모두 기록한다.
 * 준비한 응답보다 많이 부르면 unexpected에 남긴다(시험이 0개인지 단언한다)
 */
function fakeFanApi({ deviceKeys = [], refresh = [] } = {}) {
  const calls = { deviceKeys: [], refresh: [], unexpected: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const call = { url, method: init.method, credentials: init.credentials, headers: init.headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    if (/\/v1\/tickets\/[^/]+\/device-keys$/.test(new URL(url).pathname)) {
      calls.deviceKeys.push(call);
      const r = deviceKeys[calls.deviceKeys.length - 1];
      if (r) return r(call);
    } else if (new URL(url).pathname === '/v1/identity/access-tokens') {
      calls.refresh.push(call);
      const r = refresh[calls.refresh.length - 1];
      if (r) return r(call);
    }
    calls.unexpected.push(call);
    return json(599, { title: '시험이 준비하지 않은 요청' });
  };
  return calls;
}

const realFetch = globalThis.fetch;
const realApi = ORIGINS.api;
beforeEach(() => {
  ORIGINS.api = API;
  // 지난 스위치(빌드 값)는 없다: 값이 없어도 등록한다(docs/frontend.md §4.2.4 언제 부르나)
  delete process.env.NEXT_PUBLIC_WALLET_DEVICE_KEY_REGISTRATION;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  ORIGINS.api = realApi;
  delete globalThis.navigator.onLine;
  mock.timers.reset();
});

/** 이 티켓의 저장된 키 행 수(Dexie peaket-wallet deviceKeys) */
const storedCount = async (ticketId) => walletDatabase().deviceKeys.where('ticketId').equals(ticketId).count();

test('O-T44 ① 201·같은 keyId면 등록됨으로 저장하고 QR을 허락한다(본문은 ISSUE·계약 칸만)', async () => {
  const ticketId = nextTicket();
  const calls = fakeFanApi({ deviceKeys: [reply.created] });
  assert.equal(deviceKeyRegistrationAvailable(), true);

  const status = await enrollDeviceKey(ticketId);

  // 요청 하나: POST {팬 API}/v1/tickets/{ticketId}/device-keys, 쿠키 인증(openapi security fanCookie)
  assert.equal(calls.deviceKeys.length, 1);
  assert.deepEqual(calls.unexpected, []);
  const [call] = calls.deviceKeys;
  assert.equal(call.url, `${API}/v1/tickets/${ticketId}/device-keys`);
  assert.equal(call.method, 'POST');
  assert.equal(call.credentials, 'include');
  // 본문: reason ISSUE, 공개키 JWK는 계약이 받는 칸만(d 없음), boothRequestId 없음. 계약 Zod(strict)를 지난다
  assert.deepEqual(Object.keys(call.body).sort(), ['publicKeyJwk', 'reason']);
  assert.equal(call.body.reason, 'ISSUE');
  assert.equal('d' in call.body.publicKeyJwk, false);
  for (const k of Object.keys(call.body.publicKeyJwk)) assert.ok(CONTRACT_JWK_FIELDS.includes(k), `계약 밖 칸 ${k}`);
  assert.deepEqual(CreateTicketDeviceKeyBody.parse(call.body), call.body);
  assert.equal(call.body.publicKeyJwk.kty, 'EC');
  assert.equal(call.body.publicKeyJwk.crv, 'P-256');

  // 등록됨으로 저장되고 QR을 허락한다(서버 keyId = 이 기기 keyId)
  const serverKeyId = keyIdOfJwk(call.body.publicKeyJwk);
  assert.equal(status.phase, 'ready');
  assert.equal(status.localOnly, false);
  assert.equal(status.key.keyId, serverKeyId);
  assert.equal(status.key.registration, 'REGISTERED');
  const stored = await loadDeviceKey(ticketId);
  assert.equal(stored.registration, 'REGISTERED');
  assert.equal(stored.keyId, serverKeyId);
  assert.equal(stored.reason, 'ISSUE');
  assert.equal(stored.privateKey.extractable, false);
  assert.equal(await storedCount(ticketId), 1);

  // 이 키로 만든 QR 서명은 서버에 보낸 공개키로 확인된다(스캐너가 등록된 키로 확인하는 것과 같은 짝)
  const fields = { ticketId, keyId: keyIdFromBase64Url(serverKeyId), timeSeconds: 1_795_651_215 };
  const signature = await signQrV1(stored.privateKey, fields);
  const pub = createPublicKey({ key: call.body.publicKeyJwk, format: 'jwk' });
  assert.equal(nodeVerify('sha256', qrV1Message(fields), { key: pub, dsaEncoding: 'ieee-p1363' }, signature), true);
});

test('O-T44 ① 보내는 공개키 JWK는 내보낸 JWK에 개인키 칸·계약 밖 칸이 있어도 계약 칸만 싣는다', async () => {
  const calls = fakeFanApi({ deviceKeys: [reply.created] });
  const jwk = { kty: 'EC', crv: 'P-256', x: 'vR_kwCTX5DoVDyuFEmUc35dKs86osl2cbHK9blfYo5s', y: '32Yr6HPRxqUY0o8pct1HuRPYzT2B52CWAQKvrguTrB0' };
  const result = await registerDeviceKey({
    ticketId: nextTicket(),
    publicKeyJwk: { ...jwk, d: 'c2VjcmV0LXByaXZhdGUta2V5LXZhbHVlLWZvci10ZXN0', ext: true, key_ops: ['verify'], kid: 'k1', use: 'sig' },
    keyId: keyIdOfJwk(jwk),
    reason: 'ISSUE',
  });
  assert.deepEqual(result, { kind: 'registered', keyId: keyIdOfJwk(jwk) });
  assert.deepEqual(calls.deviceKeys[0].body, { publicKeyJwk: { ...jwk, ext: true, key_ops: ['verify'] }, reason: 'ISSUE' });
  assert.deepEqual(CreateTicketDeviceKeyBody.parse(calls.deviceKeys[0].body), calls.deviceKeys[0].body);
});

test('O-T44 ② 응답 keyId가 다르면 등록됨으로 바꾸지 않는다', async () => {
  for (const [label, r] of [
    ['다른 keyId', reply.createdOther],
    ['keyId 없음', reply.createdEmpty],
  ]) {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [r] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 1, label);
    const deviceKeyId = keyIdOfJwk(calls.deviceKeys[0].body.publicKeyJwk);
    // QR을 허락하지 않는 '등록 확인 전'이고, 키는 확인 전(LOCAL)으로 남는다
    assert.equal(status.phase, 'pending', label);
    assert.equal(status.key.keyId, deviceKeyId, label);
    const stored = await loadDeviceKey(ticketId);
    assert.equal(stored.registration, 'LOCAL', label);
    assert.equal(stored.keyId, deviceKeyId, label);
  }
});

test('O-T44 ③ 끊김·500·502·503·504·429면 키를 LOCAL로 두고 QR을 막는다', async () => {
  for (const [label, r] of [
    ['연결 끊김', reply.disconnect],
    ['시간 초과', reply.timeout],
    ['500', reply.status(500)],
    ['502', reply.status(502)],
    ['503', reply.status(503, 'dependency-unavailable')],
    ['504', reply.status(504)],
    ['429', reply.status(429, 'server-busy')],
  ]) {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [r] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 1, label);
    assert.deepEqual(calls.unexpected, [], label);
    const sentKeyId = keyIdOfJwk(calls.deviceKeys[0].body.publicKeyJwk);
    assert.equal(status.phase, 'pending', `${label}: '등록 확인 전'이어야 한다(QR 없음)`);
    assert.equal(status.key.keyId, sentKeyId, label);
    const stored = await loadDeviceKey(ticketId);
    assert.equal(stored?.registration, 'LOCAL', label);
    assert.equal(stored?.keyId, sentKeyId, label);
    assert.equal(await storedCount(ticketId), 1, label);
  }
});

test('O-T44 ③ 시간 초과는 쓰기 한도 15초다: 14,999ms에는 아직 기다리고 15,000ms에 끊어 다시 보낼 수 있게 둔다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let seenSignal;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      seenSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  const jwk = { kty: 'EC', crv: 'P-256', x: 'vR_kwCTX5DoVDyuFEmUc35dKs86osl2cbHK9blfYo5s', y: '32Yr6HPRxqUY0o8pct1HuRPYzT2B52CWAQKvrguTrB0' };
  let settled;
  const pending = registerDeviceKey({ ticketId: nextTicket(), publicKeyJwk: jwk, keyId: keyIdOfJwk(jwk), reason: 'ISSUE' }).then((r) => (settled = r));
  const flush = () => new Promise((r) => setImmediate(r));
  await flush();
  assert.ok(seenSignal, '요청이 나갔다');
  mock.timers.tick(14_999);
  await flush();
  assert.equal(settled, undefined, '15초 전에는 끊지 않는다');
  assert.equal(seenSignal.aborted, false);
  mock.timers.tick(1);
  await flush();
  await pending;
  assert.equal(seenSignal.aborted, true);
  assert.equal(settled.kind, 'retry');
});

test('O-T44 ④ 다시 보내기는 새 키 없이 같은 공개키로 보내고 201이면 등록됨이다', async () => {
  // 화면을 다시 열거나 [다시 시도]를 누르면 화면은 syncDeviceKeyRegistration을 부른다(ui/DeviceQr). 등록 버튼을 다시 눌러도(enrollDeviceKey) 새 키가 없다
  for (const [label, again] of [
    ['화면 다시 열기·다시 시도', (t) => syncDeviceKeyRegistration(t)],
    ['등록 버튼 다시 누름', (t) => enrollDeviceKey(t)],
  ]) {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.status(503, 'dependency-unavailable'), reply.created] });
    const first = await enrollDeviceKey(ticketId);
    assert.equal(first.phase, 'pending', label);
    const before = await loadDeviceKey(ticketId);

    const second = await again(ticketId);

    assert.equal(calls.deviceKeys.length, 2, label);
    assert.deepEqual(calls.deviceKeys[1].body.publicKeyJwk, calls.deviceKeys[0].body.publicKeyJwk, `${label}: 처음과 같은 공개키`);
    assert.equal(calls.deviceKeys[1].body.reason, 'ISSUE', label);
    assert.deepEqual(CreateTicketDeviceKeyBody.parse(calls.deviceKeys[1].body), calls.deviceKeys[1].body, label);
    // 끝나면 ①과 같다
    assert.equal(second.phase, 'ready', label);
    assert.equal(second.localOnly, false, label);
    const after = await loadDeviceKey(ticketId);
    assert.equal(after.registration, 'REGISTERED', label);
    assert.equal(after.keyId, before.keyId, `${label}: 저장된 keyId가 그대로`);
    assert.equal(after.keyId, keyIdOfJwk(calls.deviceKeys[1].body.publicKeyJwk), label);
    assert.equal(after.createdAt, before.createdAt, `${label}: 새로 만든 키가 아니다`);
    assert.equal(await storedCount(ticketId), 1, label);
  }
});

test('O-T44 ④ 오프라인이면 다시 보내지 않고 키와 확인 전 상태를 그대로 둔다', async () => {
  const ticketId = nextTicket();
  const calls = fakeFanApi({ deviceKeys: [reply.disconnect, reply.created] });
  const first = await enrollDeviceKey(ticketId);
  assert.equal(first.phase, 'pending');
  const before = await loadDeviceKey(ticketId);

  // navigator.onLine === false: 요청 0
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  const offline = await syncDeviceKeyRegistration(ticketId);
  assert.equal(calls.deviceKeys.length, 1, '오프라인에서 보냈다');
  assert.equal(offline.phase, 'pending');
  assert.equal((await loadDeviceKey(ticketId)).registration, 'LOCAL');
  delete globalThis.navigator.onLine;

  // 화면이 오프라인으로 그리는 중(미리보기 offline)도 보내지 않는다
  const preview = await syncDeviceKeyRegistration(ticketId, { offline: true });
  assert.equal(calls.deviceKeys.length, 1);
  assert.equal(preview.phase, 'pending');

  // 다시 연결되면 같은 공개키로 한 번 보내 등록된다
  const back = await syncDeviceKeyRegistration(ticketId);
  assert.equal(calls.deviceKeys.length, 2);
  assert.deepEqual(calls.deviceKeys[1].body.publicKeyJwk, calls.deviceKeys[0].body.publicKeyJwk);
  assert.equal(back.phase, 'ready');
  assert.equal((await loadDeviceKey(ticketId)).keyId, before.keyId);
});

test('O-T44 ⑤ 403 reauth-required는 다시 확인 필요, 갱신 뒤 401은 로그인이고 키는 남는다', async () => {
  // 403 reauth-required: 키는 남고 QR 없음, '다시 확인 필요'
  {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.status(403, 'reauth-required')] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 1);
    assert.equal(status.phase, 'needs-reauth');
    const stored = await loadDeviceKey(ticketId);
    assert.equal(stored.registration, 'LOCAL');
    assert.equal(stored.keyId, keyIdOfJwk(calls.deviceKeys[0].body.publicKeyJwk));
  }
  // 401 → 토큰 갱신 성공 → 다시 401: 로그인 화면, 키는 남는다
  {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.unauthorized, reply.unauthorized], refresh: [reply.refreshed] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 2);
    assert.equal(calls.refresh.length, 1);
    assert.equal(calls.refresh[0].url, `${API}/v1/identity/access-tokens`);
    assert.equal(calls.refresh[0].method, 'POST');
    assert.deepEqual(calls.deviceKeys[1].body, calls.deviceKeys[0].body, '갱신 뒤 같은 본문으로 한 번 더');
    assert.equal(status.phase, 'needs-login');
    const stored = await loadDeviceKey(ticketId);
    assert.equal(stored.registration, 'LOCAL');
    assert.equal(stored.keyId, keyIdOfJwk(calls.deviceKeys[0].body.publicKeyJwk));
  }
  // 401 → 토큰 갱신도 401(세션 끝남): 로그인 화면, 키는 남는다
  {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.unauthorized], refresh: [reply.unauthorized] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 1);
    assert.equal(calls.refresh.length, 1);
    assert.equal(status.phase, 'needs-login');
    assert.equal((await loadDeviceKey(ticketId)).registration, 'LOCAL');
    assert.deepEqual(calls.unexpected, []);
  }
  // 대조: 401 → 갱신 성공 → 201이면 끝까지 등록된다(첫 401만으로 로그인으로 보내지 않는다)
  {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.unauthorized, reply.created], refresh: [reply.refreshed] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 2);
    assert.equal(status.phase, 'ready');
    assert.equal((await loadDeviceKey(ticketId)).registration, 'REGISTERED');
  }
});

test('O-T44 ⑥ 404·422·400·booth-not-authorized 403은 이 기기 키를 지운다', async () => {
  for (const [label, r] of [
    ['404 not-found', reply.status(404, 'not-found')],
    ['422 invalid-device-key', reply.status(422, 'invalid-device-key')],
    ['400', () => json(400, { type: 'about:blank', title: 'Bad Request', status: 400 }, 'application/problem+json')],
    ['403 booth-not-authorized', reply.status(403, 'booth-not-authorized')],
    ['403 transfer-not-allowed', reply.status(403, 'transfer-not-allowed')],
    ['403 type 없음', reply.status(403)],
  ]) {
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [r] });
    const status = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 1, label);
    // 등록 전 상태 + '등록 거절' 알림, 이 기기 키는 없다
    assert.deepEqual(status, { phase: 'no-key', notice: 'rejected' }, label);
    assert.equal(await loadDeviceKey(ticketId), undefined, label);
    assert.equal(await storedCount(ticketId), 0, label);
  }
  // 등록 전 상태로 돌아갔으므로 다시 누르면 새 키를 만든다
  const ticketId = nextTicket();
  const calls = fakeFanApi({ deviceKeys: [reply.status(404, 'not-found'), reply.created] });
  await enrollDeviceKey(ticketId);
  const again = await enrollDeviceKey(ticketId);
  assert.equal(calls.deviceKeys.length, 2);
  assert.notDeepEqual(calls.deviceKeys[1].body.publicKeyJwk, calls.deviceKeys[0].body.publicKeyJwk, '지운 키를 다시 쓰지 않는다');
  assert.equal(again.phase, 'ready');
});

test('O-T44 ⑦ 팬 API 주소가 없으면 요청 없이 LOCAL 키로 QR을 허락한다', async () => {
  // 주소 없는 빌드(로컬 화면 개발): 서버를 부르지 않고 이 기기에만 둔 키로 QR
  {
    ORIGINS.api = '';
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.created] });
    assert.equal(deviceKeyRegistrationAvailable(), false);
    const status = await enrollDeviceKey(ticketId);
    assert.equal(status.phase, 'ready');
    assert.equal(status.localOnly, true);
    assert.equal(status.key.registration, 'LOCAL');
    assert.equal((await loadDeviceKey(ticketId)).registration, 'LOCAL');
    const reopened = await syncDeviceKeyRegistration(ticketId);
    assert.equal(reopened.phase, 'ready');
    assert.equal(reopened.localOnly, true);
    assert.equal(calls.deviceKeys.length, 0);
    assert.deepEqual(calls.unexpected, []);
    assert.deepEqual(await registerDeviceKey({ ticketId, publicKeyJwk: status.key.publicKeyJwk, keyId: status.key.keyId, reason: 'ISSUE' }), { kind: 'unavailable' });
    assert.equal(calls.deviceKeys.length, 0);
  }
  // 등록됨 키: 화면을 다시 열어도 서버를 부르지 않고, 등록 버튼을 다시 눌러도 새로 만들지 않는다
  {
    ORIGINS.api = API;
    const ticketId = nextTicket();
    const calls = fakeFanApi({ deviceKeys: [reply.created] });
    await enrollDeviceKey(ticketId);
    const registered = await loadDeviceKey(ticketId);
    assert.equal(registered.registration, 'REGISTERED');
    const reopened = await syncDeviceKeyRegistration(ticketId);
    const pressed = await enrollDeviceKey(ticketId);
    assert.equal(calls.deviceKeys.length, 1, '등록됨 키로 서버를 다시 불렀다');
    assert.deepEqual(calls.unexpected, []);
    for (const s of [reopened, pressed]) {
      assert.equal(s.phase, 'ready');
      assert.equal(s.localOnly, false);
      assert.equal(s.key.keyId, registered.keyId);
    }
    const after = await loadDeviceKey(ticketId);
    assert.equal(after.keyId, registered.keyId);
    assert.equal(after.createdAt, registered.createdAt);
    assert.equal(after.registration, 'REGISTERED');
  }
});
