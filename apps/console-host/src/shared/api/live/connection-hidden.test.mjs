// 탭 하나의 관제 실시간 연결(connection.ts)에서 브라우저 탭 숨김(F-03-2 OPS-360 T13, FE-T26).
// 정본: docs/frontend.md §4.4.5 '구독 수명'(숨긴 지 30초 [가정]이면 위젯 키를 모두 빼고, 다시 보이면 바로 다시 열며 키마다 위젯 조회로 최근 15분 창을
// 한 번 채운다, 늘 여는 흐름은 그대로다), §5.7 '멈추지 않는 것'(경보·명령 확인은 숨긴 동안에도 받는다), ADR-0091 결정 3, FE-T26 판정 열.
// 가짜 관제 API(live.test.fakes.mjs: 계약 모양 SSE 두 흐름과 REST)와 Node 가짜 시계(mock.timers, setTimeout·Date)로 본다. 모듈 상태가 전역이라 파일을 나눈다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from './live.test.fakes.mjs';

register('./live.test.resolve.mjs', import.meta.url);
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const CANON = { debounceMs: 1_000, hiddenMs: 30_000, refillMs: 15 * 60_000 };
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const Q = 'queue-admission-rate.summary';
const NOW = Date.parse('2026-11-23T01:00:00.000Z');

test('F-03-2 T13 FE-T26 ⑤ 숨긴 지 30초에 위젯 흐름만 닫고 늘 여는 흐름은 그대로 경보를 받으며, 다시 보이면 위젯 흐름을 바로 다시 열고 위젯 조회(최근 15분 from·to)로 채운다', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  api.install();
  const queried = [];
  api.on('GET', `/v1/ops/widgets/${Q}`, (req) => {
    queried.push(req.query);
    return json(200, { widgetKey: Q, at: '2026-11-23T01:00:30.000Z', ratio: 0.31 });
  });
  const c = await import('./connection.ts');
  const { hostStore } = await import('../../model/live-host.ts');
  try {
    c.startLive({ origin: 'https://ops-api.test/', screen: 'dashboard', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
    c.setLiveEvent(E, 'dashboard');
    await drain();
    const liveBefore = api.live().length;
    const live = api.live().at(-1);
    live.stream.push('retry: 10000\nid: 3\n\n');
    const got = [];
    const alerts = [];
    const slot = c.slotFor('queue-admission-rate');
    slot.services.data.subscribe(Q, {}, (v) => got.push(v));
    slot.services.live.on('alert', (a) => alerts.push(a.alertId));
    mock.timers.tick(CANON.debounceMs);
    await drain();
    assert.equal(api.widgets().length, 1);
    const firstWidget = api.widgets()[0];

    c.setLiveHidden(true);
    mock.timers.tick(CANON.hiddenMs - 1);
    await drain();
    assert.equal(firstWidget.stream.aborted, false, '29,999ms에는 위젯 흐름이 열려 있다');
    mock.timers.tick(1);
    await drain();
    assert.equal(firstWidget.stream.aborted, true, '30,000ms에 위젯 흐름을 닫는다');
    assert.deepEqual([...c.openWidgetKeys()], []);
    assert.deepEqual([...c.wantedWidgetKeys()], [Q], '구독자는 멈춤으로 남는다');
    // 늘 여는 흐름은 끊지도 다시 열지도 않고 숨긴 동안에도 경보를 받아 호스트 저장소에 넣는다(탭 제목 수가 이 값을 읽는다)
    assert.equal(live.stream.aborted, false);
    assert.equal(api.live().length, liveBefore);
    live.stream.push(`id: 4\nevent: alert\ndata: ${JSON.stringify({ alertId: 'a-1', name: 'QueueStall', severity: 'SEV1', status: 'firing', startsAt: '2026-11-23T01:00:20.000Z', summary: '대기열 멈춤' })}\n\n`);
    await drain();
    assert.deepEqual(alerts, ['a-1']);
    assert.deepEqual(hostStore.getState().alerts.map((a) => [a.alertId, a.severity, a.status]), [['a-1', 'SEV1', 'firing']]);
    // 늘 여는 흐름의 무소식 끊기(35초)에 닿지 않는 동안만 더 기다린다(그 판정은 F-03-1 T4가 본다)
    mock.timers.tick(4_000);
    await drain();
    assert.equal(api.widgets().length, 1, '숨긴 동안 위젯 흐름을 다시 열지 않는다');
    assert.deepEqual(queried, []);

    c.setLiveHidden(false);
    await drain();
    assert.equal(api.widgets().length, 2, '보이면 바로(1초 묶기 없이) 다시 연다');
    assert.equal(api.widgets()[1].query.widgets, Q);
    assert.equal(queried.length, 1, '키마다 위젯 조회를 한 번');
    const to = Date.parse(queried[0].to);
    assert.equal(to, NOW + CANON.debounceMs + CANON.hiddenMs + 4_000, 'to는 지금');
    assert.equal(to - Date.parse(queried[0].from), CANON.refillMs, '최근 15분 창');
    assert.equal(queried[0].eventId, E);
    assert.deepEqual(got.at(-1), { widgetKey: Q, at: '2026-11-23T01:00:30.000Z', ratio: 0.31 }, '조회 값을 같은 구독자에게 넘긴다');
    assert.equal(api.live().length, liveBefore, '늘 여는 흐름은 그대로');
    assert.equal(live.stream.aborted, false);
  } finally {
    c.stopLive();
    mock.timers.reset();
    mock.restoreAll();
  }
});
