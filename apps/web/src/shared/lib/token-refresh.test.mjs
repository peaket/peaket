// 팬 토큰 갱신 한 번(token-refresh.ts) 시험(docs/frontend.md §4.1 '401'·'시간 초과', 2026-11-06 BOT-044 뒤처리).
// 본인확인·탈퇴·로그인 수단·로그인한 기기 흐름과 팬 API 클라이언트가 잠금(peaket.refresh) 안에서 부른다. 답이 없으면 잠금을 쥔 채 멈추므로 쓰기 한도로 끝낸다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshOnce } from './token-refresh.ts';

const URL_ = 'https://api.test/v1/identity/access-tokens';
const problem = (status) => new Response(JSON.stringify({ type: 'about:blank', status }), { status, headers: { 'content-type': 'application/problem+json' } });

test('토큰갱신은POST·쿠키·no-store로한번보내고_2xx는ok·401은rejected·그밖과연결끊김은unavailable이며_받은본문은모두읽거나버린다', async () => {
  for (const [res, expected] of [
    [() => new Response(null, { status: 204 }), 'ok'],
    [() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }), 'ok'],
    [() => problem(401), 'rejected'],
    [() => problem(503), 'unavailable'],
    [() => new Response('<html>bad gateway</html>', { status: 502 }), 'unavailable'],
  ]) {
    const handed = [];
    const seen = [];
    const out = await refreshOnce(async (u, init) => {
      seen.push({ u, method: init.method, credentials: init.credentials, cache: init.cache });
      const r = res();
      handed.push(r);
      return r;
    }, URL_);
    assert.equal(out, expected);
    assert.deepEqual(seen, [{ u: URL_, method: 'POST', credentials: 'include', cache: 'no-store' }]);
    assert.deepEqual(
      handed.filter((r) => r.body && !r.bodyUsed).map((r) => r.status),
      [],
      `${expected}: 읽지도 버리지도 않은 응답(Chromium은 그 요청을 끝내지 않는다)`,
    );
  }
  assert.equal(await refreshOnce(async () => Promise.reject(new TypeError('Failed to fetch')), URL_), 'unavailable');
});

test('토큰갱신이15초안에답하지않으면unavailable로끝낸다(쓰기 한도, docs/frontend.md §4.1 시간 초과)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = async (_u, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  let out = 'pending';
  void refreshOnce(hang, URL_).then((v) => (out = v));
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await flush();
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(out, 'pending', '14.999초');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(out, 'unavailable', '15초');
});
