// 접수 요청이 네트워크 오류로 끊겨 다시 보낼 때 같은 멱등 키·같은 본문·같은 재인증 토큰 요청 하나로 보낸다(F-03-4 T7, 시험 먼저 ADR 0372번).
// 정본: docs/frontend.md §4.1 '멱등키'(그 동작을 다시 시도할 때는 같은 키와 처음 만든 본문 문자열을 그대로 쓴다), docs/api/openapi.yaml createOpsCommand
// ('같은 키·같은 본문은 처음 명령을 돌려주고 재인증 토큰을 다시 보지 않는다'), 계획 docs/review/plans/F-03-4.md 6-3.
// api-client의 자동 다시 시도 기다림이 무작위 지터라 Math.random을 0으로 둔다(클라이언트가 처음 만들어질 때 읽으므로 이 파일을 따로 둔다).
// 구현 전 트리에는 model/command-actions.ts가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { E, commandState, fakeRest, json, reauthServer } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

test('F-03-4 T7 ①-4 네트워크 오류 뒤 다시 보낸 접수 요청은 같은 Idempotency-Key·같은 본문 문자열이고, 재인증은 한 번뿐이다', async () => {
  mock.method(Math, 'random', () => 0);
  const api = fakeRest();
  const issued = reauthServer(api);
  let calls = 0;
  api.install();
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = inner(input, init);
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/v1/ops/commands' && (calls += 1) === 1) {
      await res;
      throw new TypeError('fetch failed');
    }
    return res;
  };
  api.on('POST', '/v1/ops/commands', () => json(201, commandState({ state: 'DISPATCHED' })));
  const { createCommandActions } = await import('./command-actions.ts');
  const { Submission } = await import('./command-form.ts');
  const { requestReauth } = await import('../../../features/admin-reauth/api.ts');
  const prompts = [];
  const a = createCommandActions({
    role: 'commander',
    layout: 'desktop',
    reauth: async (act) => {
      prompts.push(act);
      return requestReauth({ act, password: 'pw', code: '123456' });
    },
  });
  const sub = new Submission();
  const out = await a.submit({ kind: 'KILL_SWITCH', scope: 'EVENT', eventId: E, reason: '결제사 장애' }, sub, { reauth: true });
  assert.equal(out.kind, 'done');
  const posts = api.sent('POST', '/v1/ops/commands');
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((p) => p.headers['idempotency-key']),
    [sub.idempotencyKey, sub.idempotencyKey],
  );
  assert.equal(posts[0].raw, posts[1].raw);
  // 같은 요청의 다시 보내기라 재인증을 다시 띄우지 않는다(서버가 같은 키·같은 본문이면 토큰을 다시 보지 않는다)
  assert.deepEqual(prompts, ['OPS_COMMAND']);
  assert.equal(issued.length, 1);
});
