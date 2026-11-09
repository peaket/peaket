// 팬 세션 가게(ADR-0202 결정 2, BUILD_ORDER HOT-321): 한 번 받기, 401·실패의 나눔, 늦게 온 답 버리기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFanSessionStore } from './session-store.ts';

const unauthorized = Object.assign(new Error('401'), { status: 401 });
const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

test('처음 듣기 시작할 때 한 번만 받는다(두 부품·StrictMode 두 번 구독), 듣기만 하면 받지 않는다', async () => {
  let calls = 0;
  const s = createFanSessionStore({ apiAvailable: () => true, fetchMe: async () => (calls++, { nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: false }), isUnauthorized: () => false });
  const offListen = s.listen(() => {});
  await tick();
  assert.equal(calls, 0, '듣기만 하면 받지 않는다');
  assert.deepEqual(s.get(), { status: 'loading' });
  const seen = [];
  const off1 = s.subscribe(() => seen.push(s.get().status));
  const off2 = s.subscribe(() => {});
  off2();
  s.subscribe(() => {});
  await tick();
  assert.equal(calls, 1);
  assert.equal(s.get().status, 'member');
  assert.equal(s.get().me.name, '지민');
  assert.deepEqual(seen, ['member']);
  off1();
  offListen();
});

test('401(갱신 뒤에도)이면 비로그인, 5xx·연결 실패는 모름, API 출처가 없으면 부르지 않고 비로그인', async () => {
  const guest = createFanSessionStore({ apiAvailable: () => true, fetchMe: async () => Promise.reject(unauthorized), isUnauthorized: (e) => e === unauthorized });
  guest.subscribe(() => {});
  await tick();
  assert.deepEqual(guest.get(), { status: 'guest' });

  const down = createFanSessionStore({ apiAvailable: () => true, fetchMe: async () => Promise.reject(new Error('503')), isUnauthorized: (e) => e === unauthorized });
  down.subscribe(() => {});
  await tick();
  assert.deepEqual(down.get(), { status: 'unknown' });

  let called = false;
  const noApi = createFanSessionStore({ apiAvailable: () => false, fetchMe: async () => ((called = true), {}), isUnauthorized: () => false });
  noApi.subscribe(() => {});
  await tick();
  assert.deepEqual(noApi.get(), { status: 'guest' });
  assert.equal(called, false);
});

test('다시 받기: 받는 동안 지금 값을 두고, 늦게 온 앞선 답은 버린다', async () => {
  const answers = [];
  const s = createFanSessionStore({
    apiAvailable: () => true,
    fetchMe: () => {
      const d = deferred();
      answers.push(d);
      return d.promise;
    },
    isUnauthorized: () => false,
  });
  s.subscribe(() => {});
  answers[0].resolve({ nickname: '지민', signupCompleted: true, verified: false, hasStaffAssignment: false });
  await tick();
  assert.equal(s.get().me.verified, false);
  // 본인확인 뒤 다시 받기 두 번: 두 번째 답이 먼저 오고, 첫 번째(옛) 답이 늦게 온다
  const first = s.refresh();
  const second = s.refresh();
  assert.equal(s.get().me.verified, false, '받는 동안 지금 값');
  answers[2].resolve({ nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: false });
  await second;
  answers[1].resolve({ nickname: '지민', signupCompleted: true, verified: false, hasStaffAssignment: false });
  await first;
  assert.equal(s.get().me.verified, true, '늦게 온 옛 답은 버린다');
});

test('페이지 보관에서 돌아온 때: 이미 받기 시작했을 때만 다시 받는다', async () => {
  let calls = 0;
  let result = { nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: false };
  const s = createFanSessionStore({ apiAvailable: () => true, fetchMe: async () => (calls++, result), isUnauthorized: (e) => e === unauthorized });
  await s.refreshIfStarted();
  assert.equal(calls, 0);
  s.subscribe(() => {});
  await tick();
  // 그 사이 로그아웃했다
  result = Promise.reject(unauthorized);
  await s.refreshIfStarted();
  assert.equal(calls, 2);
  assert.deepEqual(s.get(), { status: 'guest' });
});
