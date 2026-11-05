// SCR-008 좌석 자원 미리 받기(ADR-0216 결정 2~5, docs/frontend.md §5.1 '차례와 입장'): 예상 60초 안, 리더만, 같은 경로는 한 번, 경로 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, harness, openTab, reply, stateFile } from './harness.mjs';
import { preloadAssets, preloadSeat, seatmapPath } from '../src/live/preload.ts';

const LAYOUT = '/v1/events/e1/seatmap-layouts/3.json';
const REC = { preverifyToken: 'pv', ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } };

test('SCR-008 좌석맵 경로 검사: 이 회차의 /v1/events/{id}/seatmap-layouts/{이름}.json 같은 출처 경로만(ASVS 1.2.2)', () => {
  assert.equal(seatmapPath('e1', LAYOUT), LAYOUT);
  assert.equal(seatmapPath('e 1', '/v1/events/e%201/seatmap-layouts/1.json'), '/v1/events/e%201/seatmap-layouts/1.json');
  for (const bad of [
    'https://evil.example/v1/events/e1/seatmap-layouts/3.json',
    '//evil.example/v1/events/e1/seatmap-layouts/3.json',
    '/v1/events/e2/seatmap-layouts/3.json',
    '/v1/events/e1/seatmap-layouts/../../x.json',
    '/v1/events/e1/seatmap-layouts/3.json?x=1',
    '/v1/events/e1/seatmap-layouts/3.js',
    // 판 이름은 계약의 정수 layoutVersion만(리뷰 낮음: 퍼센트로 쓴 점·빗금이 지나갔다)
    '/v1/events/e1/seatmap-layouts/%2e%2e%2f%2e%2e%2fx.json',
    '/v1/events/e1/seatmap-layouts/v3.json',
    '/v1/events/e1/seatmap-layouts/0x1.json',
    'javascript:alert(1)',
    '',
    undefined,
  ]) assert.equal(seatmapPath('e1', bad), null, String(bad));
});

test('SCR-008 좌석 화면 자산 목록(/_q/seat-preload.json v1): /_next/static/ 아래 .js·.css만, 꼴이 틀리면 빈 목록', () => {
  assert.deepEqual(preloadAssets({ v: 1, assets: ['/_next/static/chunks/a.js', '/_next/static/css/b.css', 'https://x.example/c.js', '/_next/static/../d.js', '/other/e.js', '/_next/static/f.json', 7] }), ['/_next/static/chunks/a.js', '/_next/static/css/b.css']);
  assert.deepEqual(preloadAssets({ v: 2, assets: ['/_next/static/a.js'] }), []);
  assert.deepEqual(preloadAssets(null), []);
  assert.deepEqual(preloadAssets({ v: 1 }), []);
});

test('SCR-008 미리 받기: 예상 대기가 60초 안으로 들어오면 리더가 한 번 받고, 경로가 바뀌면 다시 받는다', async () => {
  let serving = 700;
  let path = LAYOUT;
  const h = harness({ rec: REC, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving, generatedAtMs: now, seatmapLayoutPath: path })) : reply(500)) });
  await h.start();
  assert.deepEqual(h.preloads, [], '앞 299명·속도 2면 약 150초라 아직');
  serving = 900; // 앞 99명 → 약 50초(멀 때는 폴링 간격이 길어 넉넉히 기다린다)
  await h.run(15000);
  assert.deepEqual(h.preloads, [LAYOUT]);
  await h.run(3000);
  assert.deepEqual(h.preloads, [LAYOUT], '같은 경로는 한 번');
  path = '/v1/events/e1/seatmap-layouts/4.json';
  await h.run(6000);
  assert.deepEqual(h.preloads, [LAYOUT, path], '판이 바뀌면 다시');
});

test('SCR-008 미리 받기: 숨긴 탭(리더 아님)·경로 없음·검사에 걸린 경로는 받지 않는다', async () => {
  for (const [opts, file] of [
    [{ hidden: true }, { seatmapLayoutPath: LAYOUT }],
    [{}, {}],
    [{}, { seatmapLayoutPath: 'https://evil.example/v1/events/e1/seatmap-layouts/3.json' }],
  ]) {
    const h = harness({ rec: REC, ...opts, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 950, generatedAtMs: now, ...file })) : reply(500)) });
    await h.start();
    await h.run(6000);
    assert.deepEqual(h.preloads, [], JSON.stringify([opts, file]));
  }
});

test('SCR-008 preloadSeat(리뷰 중간): 좌석맵은 좌석 Worker와 같은 credentials omit·priority low, 목록은 same-origin·no-cache, 자산은 same-origin·low, 실패는 삼킨다', async () => {
  const calls = [];
  const ok = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  await preloadSeat(async (url, init) => {
    calls.push({ url, init });
    if (url === '/_q/seat-preload.json') return ok(JSON.stringify({ v: 1, assets: ['/_next/static/chunks/a.js', 'https://x.example/b.js'] }));
    if (url.endsWith('a.js')) throw new TypeError('network');
    return ok('{}');
  }, LAYOUT);
  const by = Object.fromEntries(calls.map((c) => [c.url, c.init]));
  assert.deepEqual(Object.keys(by).sort(), ['/_next/static/chunks/a.js', '/_q/seat-preload.json', LAYOUT].sort(), '검사에 걸린 자산은 받지 않는다');
  assert.deepEqual(by[LAYOUT], { priority: 'low', credentials: 'omit' });
  assert.deepEqual(by['/_q/seat-preload.json'], { priority: 'low', credentials: 'same-origin', cache: 'no-cache' });
  assert.deepEqual(by['/_next/static/chunks/a.js'], { priority: 'low', credentials: 'same-origin' });
  // 목록이 404·꼴이 틀림·연결 실패여도 던지지 않는다
  await preloadSeat(async (url) => (url === LAYOUT ? ok('{}') : Promise.reject(new TypeError('offline'))), LAYOUT);
  await preloadSeat(async () => ok('not json', 404), LAYOUT);
});

test('SCR-008 미리 받기 문턱(리뷰 낮음): 예상 61초면 아직, 59초면 받는다', async () => {
  for (const [serving, want] of [[877, 0], [881, 1]]) {
    // 앞 인원 = 1000 − serving − 1, 속도 2 → 61초·59초
    const h = harness({ rec: REC, handler: ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving, generatedAtMs: now, seatmapLayoutPath: LAYOUT })) : reply(500)) });
    await h.start();
    await h.run(1000);
    assert.equal(h.preloads.length, want, `serving ${serving}`);
  }
});

test('SCR-008 미리 받기(리뷰 낮음): 차례가 온 뒤(serving ≥ 내 순번)에는 받지 않는다(입장 확정·좌석 화면 이동과 겹치지 않게)', async () => {
  const h = harness({ rec: REC, handler: ({ m, url, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 1000, generatedAtMs: now, seatmapLayoutPath: LAYOUT })) : url.endsWith('/admission') ? reply(503, {}, { retryAfterMs: 5000 }) : reply(500)) });
  await h.start();
  await h.run(3000);
  assert.deepEqual(h.preloads, []);
});

test('SCR-008 미리 받기(리뷰 낮음): 보이는 탭 셋이면 리더 하나만 받고, 리더가 숨으면 새 리더가 한 번 받는다', async () => {
  const w = createWorld();
  w.local.setItem('peaket.queue.e1', JSON.stringify({ ticket: REC.ticket, savedAt: w.now }));
  const handler = ({ m, now }) => (m === 'GET' ? reply(200, stateFile({ serving: 950, generatedAtMs: now, seatmapLayoutPath: LAYOUT })) : reply(500));
  const tabs = [0, 1, 2].map(() => openTab(w, { multi: true, handler }));
  for (const t of tabs) await t.start();
  await w.run(4000);
  assert.deepEqual(tabs.map((t) => t.preloads.length), [1, 0, 0], '리더만');
  await tabs[0].setHidden(true);
  await w.run(6000);
  assert.deepEqual(tabs.map((t) => t.preloads.length), [1, 1, 0], '새 리더가 한 번');
});
