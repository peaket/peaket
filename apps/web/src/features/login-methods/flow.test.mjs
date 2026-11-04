// 로그인 수단 연결·해제 흐름(flow.ts) 시험(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34). 가짜 fetch·저장소로 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addResultText, createLoginMethodsApi, dayText, linkForm, markPending, PENDING_KEY, PENDING_TTL_MS, reauthForm, takePending, unlinkResultText } from './flow.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: init.headers ?? {} });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}
const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};

test('I-T33_목록은연결한순서와마지막로그인을주고_401이면갱신뒤한번더_갱신도안되면login이다', async () => {
  const ok = fakeFetch(() => json(200, { providers: [{ provider: 'kakao', linkedAt: '2026-09-01T00:00:00.000Z', lastLoginAt: '2026-11-04T00:00:00.000Z' }, { provider: 'google', linkedAt: '2026-10-02T00:00:00.000Z', lastLoginAt: null }, { provider: 'apple', linkedAt: 'x' }] }));
  assert.deepEqual(await createLoginMethodsApi({ origin: 'https://api.test', fetch: ok }).list(), {
    kind: 'ok',
    methods: [
      { provider: 'kakao', linkedAt: '2026-09-01T00:00:00.000Z', lastLoginAt: '2026-11-04T00:00:00.000Z' },
      { provider: 'google', linkedAt: '2026-10-02T00:00:00.000Z', lastLoginAt: null },
    ],
  });
  assert.deepEqual(await createLoginMethodsApi({ origin: '', fetch: fakeFetch(() => json(401)) }).list(), { kind: 'login' });
});

test('I-T33_해제는DELETE와X-Reauth-Token머리이고_204완료_409last-login-method마지막_404없음_403재인증이다', async () => {
  const done = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await createLoginMethodsApi({ origin: 'https://api.test', fetch: done }).unlink('google', 'tok'), { kind: 'done' });
  assert.equal(done.calls[0].url, 'https://api.test/v1/identity/providers/google');
  assert.equal(done.calls[0].method, 'DELETE');
  assert.equal(done.calls[0].headers['x-reauth-token'], 'tok');
  const ans = async (r) => createLoginMethodsApi({ origin: '', fetch: fakeFetch(() => r) }).unlink('kakao', 't');
  assert.deepEqual(await ans(json(409, { type: 'https://peaket.example/problems/last-login-method' })), { kind: 'last' });
  assert.deepEqual(await ans(json(404, { type: 'not-found' })), { kind: 'missing' });
  assert.deepEqual(await ans(json(403, { type: 'reauth-required' })), { kind: 'reauth' });
  assert.deepEqual(await ans(json(409, { type: 'other' })), { kind: 'error' });
  assert.equal(unlinkResultText({ kind: 'last' }).text, '마지막 로그인 수단은 해제할 수 없습니다');
});

test('재인증뒤할일은10분안이고한번만믿으며_모양이틀리면버린다_재인증·추가양식은돌아올곳과토큰을싣는다', () => {
  const s = memoryStore();
  markPending(s, { action: 'add', provider: 'google', at: 1_000 });
  assert.deepEqual(takePending(s, 1_000 + PENDING_TTL_MS), { action: 'add', provider: 'google', at: 1_000 });
  assert.equal(takePending(s, 2_000), null);
  markPending(s, { action: 'unlink', provider: 'naver', at: 1_000 });
  assert.equal(takePending(s, 1_001 + PENDING_TTL_MS), null);
  s.set(PENDING_KEY, '{"action":"drop","provider":"kakao","at":1}');
  assert.equal(takePending(s, 5), null);
  assert.deepEqual(reauthForm('kakao'), { action: '/reauth/kakao', fields: { returnTo: '/my/settings/providers', purpose: '' } });
  assert.deepEqual(linkForm('google', 'tok'), { action: '/link/google', fields: { reauthToken: 'tok', returnTo: '/my/settings/providers' } });
});

test('I-T34_추가결과값마다안내문구가있고_모르는값은null이며_날짜는KST로보인다', () => {
  for (const v of ['linked', 'already-linked', 'type-taken', 'other-account', 'reauth-required', 'failed']) assert.ok(addResultText(v), v);
  assert.equal(addResultText('linked').tone, 'success');
  assert.equal(addResultText('nope'), null);
  assert.equal(addResultText(null), null);
  assert.equal(dayText('2026-08-31T16:00:00.000Z'), '2026.09.01');
  assert.equal(dayText(null), null);
});
