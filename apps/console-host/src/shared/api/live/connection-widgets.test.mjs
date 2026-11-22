// 탭 하나의 관제 실시간 연결(connection.ts) 시험: 보이는 위젯 목록이 바뀌면 위젯 흐름만 다시 열고 늘 여는 흐름은 그대로다(F-03-1 T5, FE-T28 ⑤).
// 정본: ADR-0100 결정 2 '보이지 않는 위젯'(1초 묶어 위젯 흐름만 새 widgets로, 늘 여는 흐름은 그대로)·결정 1(urql·graphql-ws·socket.io-client를 쓰지 않는다), frontend §4.4.5.
// 가짜 관제 API(live.test.fakes.mjs)와 Node 가짜 시계(mock.timers)로 본다. 모듈 상태가 전역이라 시나리오마다 파일을 나눈다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeOpsApi, drain } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const DEBOUNCE_MS = 1_000; // frontend §4.4.5 '1초 [가정] 묶어'
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const Q = 'queue-admission-rate.summary';
const P = 'purchase-pg-status.summary';

test('F-03-1 T5 FE-T28 ⑤-3 위젯 자리를 더하면 1초 뒤 위젯 흐름만 새 widgets로 다시 열고 늘 여는 흐름은 끊지 않는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  api.install();
  const c = await import('./connection.ts');
  try {
    c.startLive({ origin: 'https://ops-api.test/', screen: 'dashboard', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
    c.setLiveEvent(E, 'dashboard');
    await drain();
    const liveBefore = api.live().length;
    assert.ok(liveBefore >= 1);
    const live = api.live().at(-1);
    assert.equal(live.query.eventId, E);
    assert.equal(live.query.screen, 'dashboard');
    live.stream.push('retry: 10000\nid: 3\n\n');

    const got = [];
    const a = c.servicesFor('slot-a');
    a.data.subscribe(Q, {}, (v) => got.push(v));
    mock.timers.tick(DEBOUNCE_MS - 1);
    await drain();
    assert.equal(api.widgets().length, 0, '999ms에는 아직 열지 않는다');
    mock.timers.tick(1);
    await drain();
    assert.equal(api.widgets().length, 1);
    assert.equal(api.widgets()[0].path, `/v1/ops/events/${E}/live`);
    assert.equal(api.widgets()[0].query.widgets, Q);

    const b = c.servicesFor('slot-b');
    b.data.subscribe(P, {}, () => undefined);
    mock.timers.tick(DEBOUNCE_MS);
    await drain();
    assert.equal(api.widgets().length, 2);
    assert.equal(api.widgets()[1].query.widgets, `${P},${Q}`);
    assert.equal(api.widgets()[0].stream.aborted, true, '앞 위젯 흐름은 닫는다');
    assert.deepEqual(c.openWidgetKeys(), [P, Q]);
    // 늘 여는 흐름은 그대로(새로 열지 않고 끊지도 않는다)
    assert.equal(api.live().length, liveBefore);
    assert.equal(live.stream.aborted, false);

    // 받은 위젯 값은 그 키 자리에 value로 간다
    api.widgets()[1].stream.push(`id: 1763859600000\nevent: widget\ndata: ${JSON.stringify({ widgetKey: Q, at: '2026-11-23T01:00:00.000Z', value: { widgetKey: Q, ratio: 0.42 } })}\n\n`);
    await drain();
    assert.deepEqual(got, [{ widgetKey: Q, ratio: 0.42 }]);
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('F-03-1 T5 FE-T28 ⑤-4 관제 콘솔과 원격 위젯의 의존에 urql·graphql-ws·socket.io-client가 없다(ADR-0100 결정 1)', () => {
  const banned = ['urql', '@urql/core', 'graphql-ws', 'socket.io-client', 'graphql'];
  const root = new URL('../../../../../../', import.meta.url);
  for (const pkg of ['apps/console-host', 'apps/widgets/queue', 'apps/widgets/purchase', 'packages/console-contract', 'packages/api-client']) {
    const json = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, root), 'utf8'));
    const deps = Object.keys({ ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies });
    assert.deepEqual(
      deps.filter((d) => banned.includes(d)),
      [],
      `${pkg} 의존`,
    );
  }
  // 잠금 파일에도 그 패키지가 없다(옮겨 온 의존 포함)
  const lock = readFileSync(new URL('pnpm-lock.yaml', root), 'utf8');
  for (const name of ['urql', 'graphql-ws', 'socket.io-client']) assert.doesNotMatch(lock, new RegExp(`^\\s+['"]?(@[^/]+/)?${name}@`, 'm'), `pnpm-lock.yaml에 ${name}`);
});
