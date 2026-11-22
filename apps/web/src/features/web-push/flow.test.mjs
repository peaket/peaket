// 웹 푸시 구독 화면 쪽 흐름 시험(BUILD_ORDER GAT-040, F-05-1, docs/frontend.md §6 FE-T48 ①~④·§4.2.4·§5.4, ADR-0363 결정 7,
// docs/features/notify.md §3.4·§3.5). 단언 값(워커 주소·범위·등록 경로·문구)은 정본 글에서 적는다.
// 바꿔 끼우는 것은 브라우저 경계(serviceWorker·PushManager·알림 권한·IndexedDB 'pending' 저장소·팬 API fetch)뿐이고 흐름(flow.ts)은 진짜다.
// 실제 core-svc에 잇는 연결 시험은 services/core-svc/test-int/web-push-wiring.int.test.ts, 실제 브라우저의 등록 유지는 tools/web-checks/reflow/web-push.spec.mjs다.
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createWebPush, PUSH_EMAIL_FALLBACK_TEXT } from './flow.ts';

const API = 'https://api.f051-push.test';
/** core-svc 고정 시험 키와 상관없는 시험용 VAPID 공개키(65바이트 비압축 P-256 점) */
const vapid = (() => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return e.getPublicKey().toString('base64url');
})();
const keys = () => ({ p256dh: (() => { const e = createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64url'); })(), auth: randomBytes(16).toString('base64url') });

/** 브라우저 PushSubscription 모양 */
function subscription(endpoint) {
  const k = keys();
  return { endpoint, toJSON: () => ({ endpoint, expirationTime: null, keys: k }), keys: k };
}

/** serviceWorker·PushManager 대역. register·subscribe 호출을 기록한다 */
function browser({ existing = null, registered = false } = {}) {
  const calls = { register: [], subscribe: [], getRegistration: [] };
  let sub = existing;
  const pushManager = {
    getSubscription: async () => sub,
    subscribe: async (o) => {
      calls.subscribe.push(o);
      sub = subscription('https://fcm.googleapis.com/fcm/send/f051-new');
      return sub;
    },
  };
  let reg = registered ? { active: { state: 'activated' }, pushManager, scope: 'https://www.peaket.example/push/' } : undefined;
  const serviceWorker = {
    register: async (url, o) => {
      calls.register.push({ url, ...o });
      reg = { active: { state: 'activated' }, pushManager, scope: `https://www.peaket.example${o.scope}` };
      return reg;
    },
    getRegistration: async (scope) => {
      calls.getRegistration.push(scope);
      return scope === '/push/' ? reg : undefined;
    },
  };
  return { calls, serviceWorker, current: () => sub };
}

/** 팬 API(POST·DELETE /v1/push-subscriptions) 대역 */
function api(answers = []) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method, credentials: init.credentials, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const a = answers[calls.length - 1] ?? 201;
    if (typeof a === 'function') return a();
    return new Response(a === 204 ? null : JSON.stringify({ subscriptionKey: 'x'.repeat(43) }), { status: a, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const problem = (status, name) => () => new Response(JSON.stringify({ type: `https://peaket.example/problems/${name}`, status }), { status, headers: { 'content-type': 'application/problem+json' } });

/** IndexedDB 'peaket-push' pending 대역 */
function pendingStore(initial) {
  let v = initial;
  const writes = [];
  return { writes, read: async () => v, write: async (p) => (writes.push(p), (v = p)), clear: async () => (v = undefined), get value() { return v; } };
}

test('FE-T48 ① [알림 켜기]를 누르면 /push/sw.js를 범위 /push/로 등록하고 구독해 POST /v1/push-subscriptions를 본문으로만 한 번 보낸다', async () => {
  const b = browser();
  const a = api([201]);
  const idb = pendingStore();
  let asked = 0;
  const push = createWebPush({ origin: API, fetch: a.fetchImpl, serviceWorker: b.serviceWorker, idb, vapidKey: vapid, permission: () => 'default', requestPermission: async () => (asked++, 'granted'), pushSupported: true });
  assert.deepEqual(await push.enable(), { kind: 'subscribed', status: 201 });
  assert.equal(asked, 1);
  assert.deepEqual(b.calls.register, [{ url: '/push/sw.js', scope: '/push/' }]);
  assert.equal(b.calls.subscribe.length, 1);
  assert.equal(b.calls.subscribe[0].userVisibleOnly, true);
  assert.deepEqual(Buffer.from(b.calls.subscribe[0].applicationServerKey).toString('base64url'), vapid);
  assert.equal(a.calls.length, 1);
  const c = a.calls[0];
  assert.equal(c.url, `${API}/v1/push-subscriptions`, '주소창(경로·쿼리)에 구독 주소·subscriptionKey가 없다');
  assert.equal(c.method, 'POST');
  assert.equal(c.credentials, 'include');
  assert.deepEqual(c.body, b.current().toJSON());
  // 저장소에 구독 주소를 남기지 않는다
  assert.deepEqual(idb.writes, []);
});

test('FE-T48 ② 권한 거부·PushManager 없음·VAPID 공개키 빌드 값 없음(틀린 꼴)은 요청 0건이고 이메일로 알려 드립니다', async () => {
  assert.equal(PUSH_EMAIL_FALLBACK_TEXT, '이메일로 알려 드립니다');
  for (const [label, over] of [
    ['권한 거부', { requestPermission: async () => 'denied' }],
    ['권한 묻기 닫음', { requestPermission: async () => 'default' }],
    ['PushManager 없음', { pushSupported: false }],
    ['serviceWorker 없음', { serviceWorker: undefined }],
    ['VAPID 없음', { vapidKey: '' }],
    ['VAPID 틀린 꼴(32바이트)', { vapidKey: randomBytes(32).toString('base64url') }],
    ['VAPID 틀린 글자', { vapidKey: `${vapid.slice(0, -2)}+/` }],
  ]) {
    const b = browser();
    const a = api();
    const push = createWebPush({ origin: API, fetch: a.fetchImpl, serviceWorker: b.serviceWorker, idb: pendingStore(), vapidKey: vapid, permission: () => 'default', requestPermission: async () => 'granted', pushSupported: true, ...over });
    const r = await push.enable();
    assert.equal(r.kind, 'email-only', label);
    assert.equal(a.calls.length, 0, `${label}: 요청`);
    assert.equal(b.calls.subscribe.length, 0, `${label}: 구독`);
  }
  // 화면(CMP-068 [알림 켜기])은 켜지 못하면 그 문구를 보인다
  const ui = readFileSync(new URL('../open-alert/OpenAlert.tsx', import.meta.url), 'utf8');
  assert.match(ui, /if \(r\.kind !== 'subscribed'\) toast\('이메일로 알려 드립니다'/);
});

test("FE-T48 ③ 등록이 422 push-service-not-allowed면 이메일로 알려 드립니다(같은 문구)", async () => {
  const b = browser();
  const a = api([problem(422, 'push-service-not-allowed')]);
  const push = createWebPush({ origin: API, fetch: a.fetchImpl, serviceWorker: b.serviceWorker, idb: pendingStore(), vapidKey: vapid, permission: () => 'default', requestPermission: async () => 'granted', pushSupported: true });
  assert.deepEqual(await push.enable(), { kind: 'email-only', reason: 'push-service-not-allowed' });
  assert.equal(a.calls.length, 1);
});

test('FE-T48 ④ 권한이 이미 허용이고 구독이 있는 브라우저에서 로그인하면 묻지 않고 지금 계정으로 다시 묶는다', async () => {
  const existing = subscription('https://fcm.googleapis.com/fcm/send/f051-existing');
  const b = browser({ existing, registered: true });
  const a = api([200]);
  let asked = 0;
  const push = createWebPush({ origin: API, fetch: a.fetchImpl, serviceWorker: b.serviceWorker, idb: pendingStore(), vapidKey: vapid, permission: () => 'granted', requestPermission: async () => (asked++, 'granted'), pushSupported: true });
  const r = await push.rebind();
  assert.equal(r.kind, 'bound');
  assert.equal(asked, 0, '권한을 새로 물었다');
  assert.deepEqual(b.calls.register, [], '워커를 새로 등록했다');
  assert.deepEqual(a.calls.map((c) => [c.method, c.url, c.body.endpoint]), [['POST', `${API}/v1/push-subscriptions`, existing.endpoint]]);
  // 권한이 허용이 아니면 묻지도 보내지도 않는다
  const b2 = browser({ existing, registered: true });
  const a2 = api();
  const r2 = await createWebPush({ origin: API, fetch: a2.fetchImpl, serviceWorker: b2.serviceWorker, idb: pendingStore(), vapidKey: vapid, permission: () => 'default', requestPermission: async () => (asked++, 'granted'), pushSupported: true }).rebind();
  assert.deepEqual(r2, { kind: 'skipped', reason: 'no-permission' });
  assert.equal(a2.calls.length, 0);
  assert.equal(asked, 0);
});

test('FE-T48 ④ peaket-push에 pending이 있는 채로 로그인하면 그것을 먼저 등록한 뒤 지운다', async () => {
  const existing = subscription('https://fcm.googleapis.com/fcm/send/f051-current');
  const pendingSub = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/f051-pending', keys: keys(), expirationTime: null, at: 1_763_900_000_000 };
  const idb = pendingStore(pendingSub);
  const b = browser({ existing, registered: true });
  const a = api([201, 200]);
  const r = await createWebPush({ origin: API, fetch: a.fetchImpl, serviceWorker: b.serviceWorker, idb, vapidKey: vapid, permission: () => 'granted', requestPermission: async () => 'granted', pushSupported: true }).rebind();
  assert.deepEqual(r, { kind: 'bound', pending: true, current: true });
  assert.deepEqual(a.calls.map((c) => c.body.endpoint), [pendingSub.endpoint, existing.endpoint], 'pending을 먼저 등록한다');
  assert.deepEqual(a.calls[0].body, { endpoint: pendingSub.endpoint, keys: pendingSub.keys, expirationTime: null });
  assert.equal(idb.value, undefined, 'pending을 지우지 않았다');
  // 등록이 실패(503)하면 pending을 남긴다
  const idb2 = pendingStore(pendingSub);
  const r2 = await createWebPush({ origin: API, fetch: api([503]).fetchImpl, serviceWorker: browser({ existing, registered: true }).serviceWorker, idb: idb2, vapidKey: vapid, permission: () => 'granted', pushSupported: true }).rebind();
  assert.deepEqual(r2, { kind: 'failed' });
  assert.deepEqual(idb2.value, pendingSub);
});

test('FE-T48 해제는 이 브라우저 구독의 subscriptionKey(구독 주소 SHA-256 base64url)로 DELETE를 보내고 브라우저 구독과 /push/ 등록은 그대로 둔다', async () => {
  const { createHash } = await import('node:crypto');
  const existing = subscription('https://fcm.googleapis.com/fcm/send/f051-logout');
  let unsubscribed = 0;
  existing.unsubscribe = async () => (unsubscribed++, true);
  const b = browser({ existing, registered: true });
  const a = api([204]);
  const r = await createWebPush({ origin: API, fetch: a.fetchImpl, serviceWorker: b.serviceWorker, idb: pendingStore(), vapidKey: vapid, permission: () => 'granted', pushSupported: true }).unbind();
  assert.deepEqual(r, { kind: 'deleted', status: 204 });
  const key = createHash('sha256').update(existing.endpoint).digest('base64url');
  assert.deepEqual(a.calls.map((c) => [c.method, c.url]), [['DELETE', `${API}/v1/push-subscriptions/${key}`]]);
  assert.equal(unsubscribed, 0);
  assert.equal(b.current(), existing);
  // 구독이 없으면 보내지 않는다
  const a2 = api();
  assert.deepEqual(await createWebPush({ origin: API, fetch: a2.fetchImpl, serviceWorker: browser({ registered: true }).serviceWorker, vapidKey: vapid, permission: () => 'granted', pushSupported: true }).unbind(), { kind: 'none' });
  assert.equal(a2.calls.length, 0);
});
