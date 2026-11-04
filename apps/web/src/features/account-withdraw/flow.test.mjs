// 탈퇴 흐름(flow.ts) 시험(docs/features/identity.md §8 '탈퇴 화면 연결', BUILD_ORDER BOT-036, I-T16·I-T68 ⑨). 가짜 fetch·저장소로 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWithdrawApi, markPending, PENDING_KEY, PENDING_TTL_MS, reauthFailureText, reauthForm, takePending, untilText } from './flow.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, type, extra = {}) => json(status, { type: `https://peaket.example/problems/${type}`, status, ...extra });

function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, credentials: init.credentials });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}

const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};

test('I-T16_로그인수단목록은연결한순서의제공자이고_401이면갱신뒤한번더_갱신도안되면login이다', async () => {
  const ok = fakeFetch((u) => (u.endsWith('/v1/identity/providers') ? json(200, { providers: [{ provider: 'naver', linkedAt: 'x', lastLoginAt: null }, { provider: 'kakao' }] }) : json(500)));
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: ok }).providers(), { kind: 'ok', providers: ['naver', 'kakao'] });
  assert.equal(ok.calls[0].url, 'https://api.test/v1/identity/providers');
  assert.equal(ok.calls[0].credentials, 'include');
  let n = 0;
  const expired = fakeFetch((u) => (u.endsWith('/access-tokens') ? json(401) : (n++, json(401))));
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: expired }).providers(), { kind: 'login' });
  assert.equal(n, 1);
  const empty = fakeFetch(() => json(200, { providers: [{ provider: 'apple' }] }));
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: empty }).providers(), { kind: 'error' });
});

test('I-T16_재인증결과는같은출처POST /reauth/token으로한번받고_실패종류를가른다', async () => {
  const ok = fakeFetch(() => json(200, { reauthToken: 'tok-1', provider: 'kakao', strength: 'verified' }));
  // 재인증 결과의 제공자를 그대로 쓴다(돌아왔을 때 로그인 수단 목록을 다시 부르지 않게, 다시 보기 낮음 4)
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: ok }).pickupReauth(), { kind: 'token', token: 'tok-1', provider: 'kakao' });
  assert.equal(ok.calls[0].url, '/reauth/token');
  assert.equal(ok.calls[0].method, 'POST');
  assert.equal(ok.calls[0].credentials, 'same-origin');
  for (const [type, reason] of [['reauth-stale', 'stale'], ['reauth-account-mismatch', 'account-mismatch'], ['reauth-reverify-required', 'reverify-required'], ['reauth-failed', 'failed'], ['reauth-result-missing', 'missing'], ['other', 'failed']]) {
    const f = fakeFetch(() => problem(type === 'reauth-result-missing' ? 404 : 409, type));
    assert.deepEqual(await createWithdrawApi({ origin: '', fetch: f }).pickupReauth(), { kind: 'failed', reason });
  }
});

test('I-T16_탈퇴는DELETE와X-Reauth-Token머리로보내고_204완료_202미룸_403재인증_그밖오류다', async () => {
  const done = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: done }).withdraw('tok-1', false), { kind: 'done' });
  const c = done.calls[0];
  assert.equal(c.url, 'https://api.test/v1/identity/account');
  assert.equal(c.method, 'DELETE');
  assert.equal(c.headers['x-reauth-token'], 'tok-1');
  assert.equal(c.body, '{}');
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => new Response(null, { status: 202 })) }).withdraw('t', false), { kind: 'deferred' });
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(403, 'reauth-required')) }).withdraw('t', false), { kind: 'reauth' });
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(500, 'internal')) }).withdraw('t', false), { kind: 'error' });
});

test('I-T68⑨_409withdrawal-confirmation-required면fraudHold를돌려주고_확인한뒤다시보내면acknowledgeFraudHold를싣는다', async () => {
  const until = '2027-01-03T15:00:00.000Z';
  const f = fakeFetch((_u, _i, n) => (n === 1 ? problem(409, 'withdrawal-confirmation-required', { fraudHold: { state: 'RESTRICTED', until } }) : new Response(null, { status: 204 })));
  const api = createWithdrawApi({ origin: '', fetch: f });
  assert.deepEqual(await api.withdraw('tok', false), { kind: 'fraudHold', state: 'RESTRICTED', until });
  assert.deepEqual(await api.withdraw('tok', true), { kind: 'done' });
  assert.equal(f.calls[1].body, JSON.stringify({ acknowledgeFraudHold: true }));
  // 모양이 틀린 409는 오류다
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(409, 'withdrawal-confirmation-required', { fraudHold: { state: 'X' } })) }).withdraw('t', false), { kind: 'error' });
  assert.equal(untilText(until), '2027년 1월 4일');
});

test('탈퇴재인증표시는_10분안이고한번만믿으며_재인증양식은돌아올곳과빈목적을싣는다', () => {
  const s = memoryStore();
  assert.equal(takePending(s, 1_000), false);
  markPending(s, 1_000);
  assert.equal(s.m.get(PENDING_KEY), '1000');
  assert.equal(takePending(s, 1_000 + PENDING_TTL_MS), true);
  assert.equal(takePending(s, 1_000 + PENDING_TTL_MS), false);
  markPending(s, 1_000);
  assert.equal(takePending(s, 1_001 + PENDING_TTL_MS), false);
  s.set(PENDING_KEY, 'junk');
  assert.equal(takePending(s, 5), false);
  assert.deepEqual(reauthForm('naver'), { action: '/reauth/naver', fields: { returnTo: '/my/settings', purpose: '' } });
});

test('I-T16_재인증실패문구는이유마다다르고_갱신은재인증양식을보내기전에부를수있다', async () => {
  assert.equal(reauthFailureText('stale'), '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요');
  assert.match(reauthFailureText('account-mismatch'), /다른 계정으로 다시 로그인했습니다/);
  assert.match(reauthFailureText('expired'), /5분이 지났습니다/);
  assert.equal(reauthFailureText('failed'), reauthFailureText('missing'));
  const f = fakeFetch((u) => (u.endsWith('/v1/identity/access-tokens') ? new Response(null, { status: 204 }) : json(500)));
  assert.equal(await createWithdrawApi({ origin: 'https://api.test', fetch: f }).refresh(), true);
  assert.equal(f.calls[0].url, 'https://api.test/v1/identity/access-tokens');
  assert.equal(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => json(401)) }).refresh(), false);
});
