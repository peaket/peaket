// 원격 진입 주소 정책(peaket-remote)과 실패 수 보내기 단위 시험(F-03-2 OPS-350 T5·T7, FE-T39, ASVS 16.3.3).
// 정본: docs/frontend.md §5.14.1 'Trusted Types' ②(peaket-remote는 remotes.json에 있는 /remotes/<이름>/<sha>/remoteEntry.js만 통과,
// 같은 출처 경로 그대로·쿼리·조각·점 경로 없음), §5.7 '원격 실패'(remote_load_failed_total{remote, reason}, 첫 실패 뒤 1초 [가정] 묶어
// 같은 출처 /_t/rum counters로), asyncapi RumSample 판 2(counters 꼴, 사람 식별값·주소 없음), ADR-0361 결정 3·5.
// 목록 밖 주소마다 거절을 본다(F-03-1 검증에서 살아남은 '덧14': 앞부분만 보는 정책). 브라우저 위 정책은 tools/web-checks/console-remotes/가 본다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../api/live/live.test.resolve.mjs', import.meta.url);
const { isAllowedRemoteEntry } = await import('./load-remote.ts');
const { createRemoteFailures } = await import('./remote-failures.ts');

const BASE = 'https://console.peaket.test/dashboard?tab=live';
const Q = '/remotes/queue/0a1b2c3d4e5f/remoteEntry.js';
const P = '/remotes/purchase/9f8e7d6c5b4a/remoteEntry.js';
const ALLOWED = new Set([Q, P]);

test('F-03-2 T5 FE-T39 ② peaket-remote 판정은 읽은 목록의 정식 주소만 통과시키고 목록 밖 주소마다 거절한다', () => {
  assert.equal(isAllowedRemoteEntry(Q, BASE, ALLOWED), true);
  assert.equal(isAllowedRemoteEntry(P, BASE, ALLOWED), true);
  const outside = [
    // 같은 원격의 다른 판(목록에 없는 sha)·다른 원격 이름·원격 폴더의 다른 파일
    '/remotes/queue/ffffffffffff/remoteEntry.js',
    '/remotes/ads/0a1b2c3d4e5f/remoteEntry.js',
    '/remotes/queue/0a1b2c3d4e5f/w-queue-admission-rate.chunk.js',
    '/remotes/queue/remoteEntry.js',
    // 같은 경로라도 다른 출처·쿼리·조각·점 경로·인코딩·절대 주소 꼴
    `https://evil.example${Q}`,
    `//evil.example${Q}`,
    `https://console.peaket.test${Q}`,
    `${Q}?v=2`,
    `${Q}#a`,
    '/remotes/queue/0a1b2c3d4e5f/../0a1b2c3d4e5f/remoteEntry.js',
    '/remotes/queue/./0a1b2c3d4e5f/remoteEntry.js',
    '/remotes/queue%2F0a1b2c3d4e5f/remoteEntry.js',
    'remotes/queue/0a1b2c3d4e5f/remoteEntry.js',
    `data:text/javascript,1`,
    `blob:https://console.peaket.test/1234`,
    'javascript:alert(1)',
    '',
  ];
  for (const url of outside) assert.equal(isAllowedRemoteEntry(url, BASE, ALLOWED), false, url);
  // 목록이 비면(목록을 못 읽음·모두 거절) 아무것도 통과하지 않는다
  assert.equal(isAllowedRemoteEntry(Q, BASE, new Set()), false);
});

/** 가짜 시계(setTimeout만) */
function clock() {
  let now = 0;
  const q = [];
  return {
    setTimeout: (fn, ms) => q.push({ at: now + ms, fn }),
    async advance(ms) {
      now += ms;
      for (const t of q.filter((x) => x.at <= now)) {
        q.splice(q.indexOf(t), 1);
        await t.fn();
      }
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    },
  };
}

test('F-03-2 T7 [ASVS v5.0.0-16.3.3] 실패 수는 첫 실패 뒤 1초 묶어 /_t/rum counters 한 건으로 보내고, 다른 값(주소·검색어·사람 식별값)을 싣지 않는다', async () => {
  const sent = [];
  const timers = clock();
  const f = createRemoteFailures({ send: async (path, body) => void sent.push({ path, body: JSON.parse(body) }), timers, uuid: () => '00000000-0000-4000-8000-000000000001' });
  f.count('queue', 'integrity');
  await timers.advance(999);
  assert.equal(sent.length, 0, '999ms에는 아직');
  f.count('purchase', 'timeout');
  f.count('queue', 'integrity');
  await timers.advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/_t/rum');
  assert.deepEqual(sent[0].body, {
    schemaVersion: 2,
    eventKey: '00000000-0000-4000-8000-000000000001',
    app: 'console',
    route: '/dashboard',
    counters: [
      { name: 'remote_load_failed_total', labels: { remote: 'queue', reason: 'integrity' }, value: 2 },
      { name: 'remote_load_failed_total', labels: { remote: 'purchase', reason: 'timeout' }, value: 1 },
    ],
  });
  // 라벨 값은 정본 열거(remote queue·purchase, reason 일곱)만: 밖의 값은 세지 않는다(라벨 가짓수를 늘리지 않는다, frontend §5.16)
  f.count('https://evil.example/x', 'integrity');
  f.count('queue', 'CSP');
  await timers.advance(1_000);
  assert.equal(sent.length, 1);
  // 보내기가 실패해도 던지지 않는다(지표는 잃어도 된다)
  const g = createRemoteFailures({ send: async () => Promise.reject(new Error('405')), timers, uuid: () => 'u' });
  g.count('queue', 'list');
  await assert.doesNotReject(g.flush());
});
