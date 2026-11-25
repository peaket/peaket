// 월렛 재발급 화면 흐름 시험(BUILD_ORDER GAT-020, F-05-1, docs/features/offline-gate.md §11 O-T49·O-T6, ADR-0363 결정 2·3,
// docs/frontend.md §3.12 `peaket.wallet.reauth`·§4.2.4 '다시 확인', docs/design/d5 §5.13 상태 이름).
// - 바꿔 끼우는 것은 팬 API 경계(주입한 fetch: gw-fan → ticket-svc)·재인증 토큰 받기(POST /reauth/token 앞 pickup)·재인증 양식 보내기(submit)·
//   탭 저장소(메모리 Storage)·IndexedDB(fake-indexeddb)뿐이다. 흐름(enrollment.ts·reauth-return.ts·register.ts)과 저장소(store.ts)는 진짜다.
// - 응답의 keyId는 구현 코드를 쓰지 않고 정본의 식(공개키 SPKI DER의 SHA-256 앞 8바이트, base64url)을 node:crypto로 따로 계산한다.
// - 같은 흐름을 실제 ticket-svc에 잇는 연결 시험은 services/ticket-svc/test-int/wallet-reissue-wiring.int.test.ts다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// reauth-return.ts가 가져오는 shared/lib/reauth-return.ts는 확장자 없는 가져오기('./reauth-failure')를 써서 node가 바로 읽지 못한다.
// 이 시험 안에서만 가져오기 갈고리로 확장자를 붙인다(shared/lib/refresh-lock.test.mjs와 같은 방법). 흐름 모듈은 그 뒤에 불러온다
const SRC = new URL('../../', import.meta.url);
const withExt = (u) => [u, `${u}.ts`, `${u}.tsx`, `${u}/index.ts`].find((c) => existsSync(new URL(c)));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const found = withExt(new URL(specifier.slice(2), SRC).href);
      if (found) return next(found, context);
    }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const found = withExt(new URL(specifier, context.parentURL).href);
      if (found) return next(found, context);
    }
    return next(specifier, context);
  },
});
const { enrollDeviceKey, sendWithReauth, syncDeviceKeyRegistration } = await import('./enrollment.ts');
const { leaveForWalletReauth, resumeWalletReauth, takeWalletReauth } = await import('./reauth-return.ts');
const { walletScreenStateOf } = await import('./register.ts');
const { loadDeviceKey } = await import('./store.ts');

/** 시험용 팬 API 출처(코드 기본값과 다르게) */
const API = 'https://api.f051.test';
const PROBLEM = 'https://peaket.example/problems/';
/** 정본의 탭 저장소 키 이름(frontend §3.12) */
const MARKER_KEY = 'peaket.wallet.reauth';
/** 표시를 믿는 시간 10분(frontend §3.12 '남긴 지 10분 [가정] 안일 때만 믿는다') */
const TEN_MIN = 10 * 60_000;
/** 떠난 시각(KST 2026-11-23 19:12:40) */
const LEFT_AT = Date.parse('2026-11-23T10:12:40.000Z');

let n = 0;
const nextTicket = () => `0190f3a1-7c2e-7a00-8000-${String(510_000 + n++).padStart(12, '0')}`;

function keyIdOfJwk(jwk) {
  const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest().subarray(0, 8).toString('base64url');
}
const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, name) => json(status, { type: `${PROBLEM}${name}`, title: '오류', status }, 'application/problem+json');
const reply = {
  created: (call) => json(201, { keyId: keyIdOfJwk(call.body.publicKeyJwk) }),
  status: (s, name) => () => problem(s, name),
};

/** 가짜 팬 API(기기 키 등록 경로만). 준비한 응답을 차례로 쓰고 모든 요청을 기록한다. 그 밖의 요청은 unexpected */
function fanApi(answers = []) {
  const calls = [];
  const unexpected = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (!/^\/v1\/tickets\/[^/]+\/device-keys$/.test(path)) {
      unexpected.push(url);
      return json(599, {});
    }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call = { url, method: init.method, headers, body: JSON.parse(String(init.body)), storedBeforeSend: await loadDeviceKey(path.split('/')[3]) };
    calls.push(call);
    const r = answers[calls.length - 1];
    return r ? r(call) : json(599, {});
  };
  return { calls, unexpected, fetchImpl, opts: { origin: API, fetch: fetchImpl } };
}

/** 탭 저장소(sessionStorage 모양) */
function tabStore() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** 재인증 양식 보내기 기록 */
function submitSpy() {
  const sent = [];
  return { sent, submit: (provider, returnTo, purpose) => sent.push({ provider, returnTo, purpose }) };
}

test('O-T49 ① 403 reissue-required면 키를 두고 저장소 유실, 입장 시작 전이며 QR을 허락하지 않고 다시 열어도 보내지 않는다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.status(403, 'reissue-required')]);
  const st = await enrollDeviceKey(ticketId, api.opts);
  assert.equal(api.calls.length, 1);
  assert.equal(st.phase, 'reissue-required');
  assert.equal(walletScreenStateOf({ kind: 'reissue-required', withToken: false }), '저장소 유실, 입장 시작 전');
  const stored = await loadDeviceKey(ticketId);
  assert.equal(stored.registration, 'LOCAL');
  assert.equal(stored.keyId, keyIdOfJwk(api.calls[0].body.publicKeyJwk));
  // 화면을 다시 열어도 재인증 없이 다시 보내지 않는다(QR도 없다)
  const reopened = await syncDeviceKeyRegistration(ticketId, api.opts);
  assert.equal(reopened.phase, 'reissue-required');
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.unexpected, []);
});

test('O-T49 ① 화면은 저장소 유실, 입장 시작 전에 d5 문구와 [ 다시 로그인하고 받기 ]를 그리고 QR을 그리지 않는다', () => {
  const src = readFileSync(new URL('./ui/DeviceQr.tsx', import.meta.url), 'utf8');
  const at = src.indexOf("if (status?.phase === 'reissue-required') {");
  assert.ok(at > 0, '저장소 유실, 입장 시작 전 갈래가 없다');
  const block = src.slice(at, src.indexOf('\n  if (status?.phase', at + 10));
  // d5 §5.13 CMP-045 문구와 버튼
  assert.match(block, /이 기기에서 티켓을 다시 받아야 합니다/);
  assert.match(block, /다시 로그인하고 받기/);
  assert.match(block, /return \(/, '이 갈래에서 바로 그리고 끝나지 않는다(QR 아래로 흐른다)');
  assert.doesNotMatch(block, /matrix|<svg|QrCode/i);
  // 저장소 유실, 입장 시작 뒤: 안내 글만, 부스 재발급 버튼은 GAT-190 전까지 없다(ADR-0363 결정 9)
  const boothAt = src.indexOf("if (status?.phase === 'reissue-at-booth') {");
  // 주석은 빼고 본다(주석이 버튼 이름을 말한다)
  const booth = src.slice(boothAt, src.indexOf('\n  if (status?.phase', boothAt + 10)).replace(/^\s*\/\/.*$/gm, '');
  assert.match(booth, /현장 부스에서 다시 받을 수 있습니다/);
  assert.match(booth, /boothReissue/, '월렛이 부스 재발급 부품을 넣어야 한다');
  const live = readFileSync(new URL('../../widgets/ticket-wallet/ui/BoothReissueLive.tsx', import.meta.url), 'utf8');
  assert.match(live, /부스 재발급 요청/);
  assert.match(live, /leaveForWalletReauth/);
  assert.match(live, /reason: 'BOOTH'/);
});

test('O-T49 ② 떠날 때 표시에는 티켓 ID·이유·시각만 있고, 돌아오면 지운 뒤 같은 공개키로 REISSUE와 X-Reauth-Token을 한 번 보내 201이면 QR이 나온다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.status(403, 'reissue-required'), reply.created]);
  await enrollDeviceKey(ticketId, api.opts);
  const before = await loadDeviceKey(ticketId);
  const tab = tabStore();
  const spy = submitSpy();
  leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: spy.submit });
  // 탭 저장소: 티켓 ID·이유·시각(판 표시 v 말고는 없다). 토큰·공개키는 넣지 않는다
  const raw = tab.getItem(MARKER_KEY);
  const marker = JSON.parse(raw);
  assert.deepEqual(Object.keys(marker).filter((k) => k !== 'v').sort(), ['at', 'reason', 'ticketId']);
  assert.deepEqual({ ticketId: marker.ticketId, reason: marker.reason, at: marker.at }, { ticketId, reason: 'REISSUE', at: LEFT_AT });
  assert.doesNotMatch(raw, new RegExp(before.publicKeyJwk.x.slice(0, 16)));
  // 재인증은 웹 purpose device-key-issue로, 돌아올 곳은 그 티켓 펼침
  assert.deepEqual(spy.sent, [{ provider: 'kakao', returnTo: `/my/tickets/${ticketId}`, purpose: 'device-key-issue' }]);

  const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 4 * 60_000, pickup: async () => ({ kind: 'token', token: 'reauth-f051-a' }), ...api.opts });
  assert.equal(tab.getItem(MARKER_KEY), null, '돌아오면 표시를 지운다');
  assert.equal(api.calls.length, 2);
  const sent = api.calls[1];
  assert.equal(sent.body.reason, 'REISSUE');
  assert.equal(sent.headers['x-reauth-token'], 'reauth-f051-a');
  assert.equal(keyIdOfJwk(sent.body.publicKeyJwk), before.keyId, '같은 공개키');
  assert.equal(r.kind, 'sent');
  assert.equal(r.status.phase, 'ready');
  assert.equal((await loadDeviceKey(ticketId)).registration, 'REGISTERED');
  assert.deepEqual(api.unexpected, []);
});

test('O-T49 ② 이 기기에 키가 없으면(저장소 유실) 돌아와서 키를 새로 만들어 확인 전으로 먼저 저장한 뒤 보낸다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.created]);
  const tab = tabStore();
  leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'naver', submit: submitSpy().submit });
  assert.equal(await loadDeviceKey(ticketId), undefined);
  const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 1_000, pickup: async () => ({ kind: 'token', token: 'reauth-f051-b' }), ...api.opts });
  assert.equal(api.calls.length, 1);
  // 보낼 때 이미 '확인 전'(LOCAL)으로 저장돼 있었고 그 키를 보냈다
  assert.equal(api.calls[0].storedBeforeSend.registration, 'LOCAL');
  assert.equal(api.calls[0].storedBeforeSend.keyId, keyIdOfJwk(api.calls[0].body.publicKeyJwk));
  assert.equal(api.calls[0].body.reason, 'REISSUE');
  assert.equal(r.status.phase, 'ready');
});

test('O-T49 ③ 표시를 남긴 지 10분이 지나면 요청 없이 표시를 지우고 ①로 돌아가며, 꼭 10분이면 아직 믿는다', async () => {
  // 10분 + 1ms: 낡음
  {
    const ticketId = nextTicket();
    const api = fanApi([reply.status(403, 'reissue-required')]);
    await enrollDeviceKey(ticketId, api.opts);
    const tab = tabStore();
    leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
    let picked = 0;
    const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + TEN_MIN + 1, pickup: async () => (picked++, { kind: 'token', token: 'x' }), ...api.opts });
    assert.equal(r.kind, 'stale');
    assert.equal(r.status.phase, 'reissue-required');
    assert.equal(api.calls.length, 1, '낡은 표시로 보냈다');
    assert.equal(picked, 0, '낡은 표시로 토큰을 받았다');
    assert.equal(tab.getItem(MARKER_KEY), null);
  }
  // 꼭 10분: 믿고 보낸다
  {
    const ticketId = nextTicket();
    const api = fanApi([reply.status(403, 'reissue-required'), reply.created]);
    await enrollDeviceKey(ticketId, api.opts);
    const tab = tabStore();
    leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
    const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + TEN_MIN, pickup: async () => ({ kind: 'token', token: 'y' }), ...api.opts });
    assert.equal(r.kind, 'sent');
    assert.equal(api.calls.length, 2);
  }
});

test('O-T49 ③ 재인증이 실패·취소되면 요청 없이 표시를 지우고 ①로 돌아간다(실패 문구 까닭을 넘긴다)', async () => {
  for (const reason of ['missing', 'account-mismatch', 'failed']) {
    const ticketId = nextTicket();
    const api = fanApi([reply.status(403, 'reissue-required')]);
    await enrollDeviceKey(ticketId, api.opts);
    const tab = tabStore();
    leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
    const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 30_000, pickup: async () => ({ kind: 'failed', reason }), ...api.opts });
    assert.deepEqual({ kind: r.kind, reason: r.reason, phase: r.status.phase }, { kind: 'reauth-failed', reason, phase: 'reissue-required' }, reason);
    assert.equal(api.calls.length, 1, reason);
    assert.equal(tab.getItem(MARKER_KEY), null, reason);
    assert.equal((await loadDeviceKey(ticketId)).registration, 'LOCAL', `${reason}: 키는 남는다`);
  }
});

test('O-T49 ④ 재인증 뒤 재발급이 429면 재발급 한도다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.status(403, 'reissue-required'), () => json(429, { type: `${PROBLEM}too-many-requests`, title: '24시간', status: 429 }, 'application/problem+json')]);
  await enrollDeviceKey(ticketId, api.opts);
  const tab = tabStore();
  leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
  const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 1_000, pickup: async () => ({ kind: 'token', token: 'z' }), ...api.opts });
  assert.equal(r.status.phase, 'reissue-limit');
  assert.equal(walletScreenStateOf({ kind: 'reissue-limit' }), '재발급 한도');
  assert.equal(api.calls.length, 2);
});

test('O-T49 ⑤ 403 reissue-at-booth면 저장소 유실, 입장 시작 뒤이고 키는 이 기기에 남지 않는다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.status(403, 'reissue-at-booth')]);
  const st = await enrollDeviceKey(ticketId, api.opts);
  assert.deepEqual(st, { phase: 'reissue-at-booth' });
  assert.equal(walletScreenStateOf({ kind: 'reissue-at-booth' }), '저장소 유실, 입장 시작 뒤');
  assert.equal(await loadDeviceKey(ticketId), undefined);
  // 재인증 뒤 보낸 요청이 reissue-at-booth여도 같다(입장이 그사이 시작됨)
  const t2 = nextTicket();
  const api2 = fanApi([reply.status(403, 'reissue-required'), reply.status(403, 'reissue-at-booth')]);
  await enrollDeviceKey(t2, api2.opts);
  const tab = tabStore();
  leaveForWalletReauth({ ticketId: t2, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
  const r = await resumeWalletReauth(t2, { store: tab, now: () => LEFT_AT + 1_000, pickup: async () => ({ kind: 'token', token: 'w' }), ...api2.opts });
  assert.equal(r.status.phase, 'reissue-at-booth');
  assert.equal(await loadDeviceKey(t2), undefined);
});

test('O-T49 ⑥ 403 reauth-required(입장 시작 뒤 첫 등록) 뒤 재인증으로 돌아오면 reason ISSUE와 토큰으로 한 번 나간다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.status(403, 'reauth-required'), reply.created]);
  const st = await enrollDeviceKey(ticketId, api.opts);
  assert.equal(st.phase, 'needs-reauth');
  assert.equal(walletScreenStateOf({ kind: 'needs-reauth', withToken: false }), '다시 확인 필요');
  const kept = await loadDeviceKey(ticketId);
  const tab = tabStore();
  leaveForWalletReauth({ ticketId, reason: 'ISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
  assert.equal(JSON.parse(tab.getItem(MARKER_KEY)).reason, 'ISSUE');
  const r = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 2_000, pickup: async () => ({ kind: 'token', token: 'reauth-f051-c' }), ...api.opts });
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].body.reason, 'ISSUE');
  assert.equal(api.calls[1].headers['x-reauth-token'], 'reauth-f051-c');
  assert.equal(keyIdOfJwk(api.calls[1].body.publicKeyJwk), kept.keyId);
  assert.equal(r.status.phase, 'ready');

  // BOOTH도 같은 왕복을 쓴다: 표시에 boothRequestId를 남기고(코드·토큰 아님), 돌아오면 reason BOOTH와 X-Reauth-Token으로 한 번 보낸다
  const boothTicket = nextTicket();
  const boothApi = fanApi([reply.created]);
  const boothRequestId = '0190f3a1-7c2e-7a00-8000-00000000b0b1';
  const boothTab = tabStore();
  leaveForWalletReauth({ ticketId: boothTicket, reason: 'BOOTH', boothRequestId }, { store: boothTab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
  const boothMarker = JSON.parse(boothTab.getItem(MARKER_KEY));
  assert.deepEqual({ reason: boothMarker.reason, boothRequestId: boothMarker.boothRequestId }, { reason: 'BOOTH', boothRequestId });
  const br = await resumeWalletReauth(boothTicket, { store: boothTab, now: () => LEFT_AT + 3_000, pickup: async () => ({ kind: 'token', token: 'reauth-f051-booth' }), ...boothApi.opts });
  assert.equal(boothApi.calls.length, 1);
  assert.equal(boothApi.calls[0].body.reason, 'BOOTH');
  assert.equal(boothApi.calls[0].body.boothRequestId, boothRequestId);
  assert.equal(boothApi.calls[0].headers['x-reauth-token'], 'reauth-f051-booth');
  assert.equal(br.kind, 'sent');
  assert.equal(br.status.phase, 'ready');

  // IR-01: 재인증 복귀 때 책임자가 아직 코드를 찍지 않았으면 같은 boothRequestId로 기다리고 로컬 키를 지우지 않는다
  const waitTicket = nextTicket();
  const waitRequest = '0190f3a1-7c2e-7a00-8000-00000000b0b2';
  const waitApi = fanApi([reply.status(403, 'booth-not-authorized')]);
  const wait = await sendWithReauth({ ticketId: waitTicket, reason: 'BOOTH', boothRequestId: waitRequest, reauthToken: 'reauth-f051-wait', ...waitApi.opts });
  assert.equal(wait.phase, 'booth-waiting');
  assert.equal(wait.phase === 'booth-waiting' ? wait.boothRequestId : undefined, waitRequest);
  assert.equal((await loadDeviceKey(waitTicket))?.registration, 'LOCAL');
});

test('O-T49 ⑦ 돌아온 뒤 새로고침하면 표시가 없어 다시 보내지 않는다', async () => {
  const ticketId = nextTicket();
  const api = fanApi([reply.status(403, 'reissue-required'), reply.status(503, 'dependency-unavailable')]);
  await enrollDeviceKey(ticketId, api.opts);
  const tab = tabStore();
  leaveForWalletReauth({ ticketId, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
  await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 1_000, pickup: async () => ({ kind: 'token', token: 'v' }), ...api.opts });
  assert.equal(api.calls.length, 2);
  // 새로고침: 표시가 없다 → 요청 없음
  let picked = 0;
  const again = await resumeWalletReauth(ticketId, { store: tab, now: () => LEFT_AT + 2_000, pickup: async () => (picked++, { kind: 'token', token: 'v2' }), ...api.opts });
  assert.equal(again.kind, 'none');
  assert.equal(picked, 0);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(takeWalletReauth(tab, LEFT_AT + 3_000), { kind: 'none' });
});

test('O-T49 다른 티켓의 표시는 이 티켓에서 쓰지 않는다', async () => {
  const mine = nextTicket();
  const other = nextTicket();
  const api = fanApi([]);
  const tab = tabStore();
  leaveForWalletReauth({ ticketId: other, reason: 'REISSUE' }, { store: tab, now: () => LEFT_AT, provider: 'kakao', submit: submitSpy().submit });
  let picked = 0;
  const r = await resumeWalletReauth(mine, { store: tab, now: () => LEFT_AT + 1_000, pickup: async () => (picked++, { kind: 'token', token: 'u' }), ...api.opts });
  assert.equal(r.kind, 'none');
  assert.equal(picked, 0);
  assert.equal(api.calls.length, 0);
});
