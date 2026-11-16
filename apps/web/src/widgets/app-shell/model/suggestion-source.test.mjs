// 머리 검색창 자동완성을 늦게 싣는 출처 시험(계획 BAT-165 '### 18', docs/frontend.md §5.8 '머리 검색창 자동완성은 늦게 싣는다').
// 자동완성 모듈은 진짜(./autocomplete.ts)를 쓰되 약속을 시험이 끝낸다(모듈이 아직 오지 않은 때를 만든다). 서버는 가짜다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSuggestionSource } from './suggestion-source.ts';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const items = (...labels) => labels.map((label, i) => ({ kind: 'PRODUCTION', label, productionId: `p${i}`, eventId: `e${i}`, matches: [] }));

function harness(o = {}) {
  let resolve;
  let reject;
  const pending = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  const calls = { imports: 0, server: [] };
  const src = createSuggestionSource({
    importAutocomplete: () => {
      calls.imports += 1;
      return pending;
    },
    fetchSuggestions: async (q) => {
      calls.server.push(q);
      return o.answer ? o.answer(q) : items('루멘 콘서트', '루멘 팬미팅');
    },
    now: () => T0,
  });
  return { src, calls, give: async () => resolve(await import('./autocomplete.ts')), fail: () => reject(new Error('덩어리를 받지 못했다')) };
}
const labels = (r) => (r ?? []).map((x) => x.label);

test('머리 검색창은 자동완성 모듈이 오기 전 peek가 답을 정하지 않고 load로 넘기며, load는 모듈을 받은 뒤 지금 규칙대로 답한다(BAT-165 첫 JS)', async () => {
  const h = harness();
  // 모듈이 오기 전: peek는 답을 정하지 않는다(undefined). warm 전에는 가져오지 않는다
  assert.equal(h.src.peek('루'), undefined);
  assert.equal(h.calls.imports, 0);
  h.src.warm();
  assert.equal(h.calls.imports, 1);
  h.src.warm();
  h.src.warm();
  assert.equal(h.calls.imports, 1, 'warm을 여러 번 불러도 한 번');
  // load는 모듈을 받은 뒤 서버를 한 번 부른다
  const ctrl = new AbortController();
  const pendingLoad = h.src.load('루', ctrl.signal);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.calls.server, [], '모듈이 오기 전에는 서버를 부르지 않는다');
  await h.give();
  assert.deepEqual(labels(await pendingLoad), ['루멘 콘서트', '루멘 팬미팅']);
  assert.deepEqual(h.calls.server, ['루']);
  // 요청 최소 길이 미만(로마자 한 글자)은 null이고 서버를 부르지 않는다
  assert.equal(await h.src.load('l', ctrl.signal), null);
  assert.equal(h.calls.server.length, 1);
  // 모듈이 온 뒤: 받은 후보 안에서 거를 수 있는 입력은 peek가 곧바로 그 후보이고 서버를 부르지 않는다(지금 동작)
  assert.deepEqual(labels(await h.src.load('루멘', ctrl.signal)), ['루멘 콘서트', '루멘 팬미팅']);
  assert.equal(h.calls.server.length, 2);
  assert.deepEqual(labels(h.src.peek('루멘 콘')), ['루멘 콘서트']);
  assert.equal(h.calls.server.length, 2);
  // 최소 길이 미만은 peek도 null(창 없음)
  assert.equal(h.src.peek('l'), null);
});

test('자동완성 모듈을 받지 못하면 창을 띄우지 않고 던지지 않는다(BAT-165 첫 JS)', async () => {
  const h = harness();
  h.src.warm();
  h.fail();
  const out = await h.src.load('루', new AbortController().signal);
  assert.equal(out, null);
  assert.deepEqual(h.calls.server, []);
});

test('자동완성 후보를 고르면 선택 사건(종류·보인 목록의 1부터 위치)을 세고 곧바로 한 번 보낸다(BAT-165 첫 JS, V165-L9)', async () => {
  // 고르면 화면을 옮기므로 떠날 때 보내기에 기대지 않고 바로 보낸다(ADR-0271 결정 16·20)
  const log = [];
  const fakeQuality = { suggestShown: () => log.push('shown'), suggestSelected: (kind, position) => log.push(`selected:${kind}:${position}`), flush: async () => log.push('flush'), resultsShown: () => {}, resultClick: () => {} };
  const src = createSuggestionSource({
    importAutocomplete: () => import('./autocomplete.ts'),
    fetchSuggestions: async () => items('루멘 콘서트', '루멘 팬미팅', '루멘 앙코르'),
    now: () => T0,
    quality: (fn) => fn(fakeQuality),
  });
  src.warm();
  const shown = await src.load('루멘', new AbortController().signal);
  assert.equal(shown.length, 3);
  log.length = 0;
  src.selected(shown[2].href);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ['selected:PRODUCTION:3', 'flush']);
  // 보인 목록에 없는 주소는 세지도 보내지도 않는다
  log.length = 0;
  src.selected('/search?q=x');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, []);
});
