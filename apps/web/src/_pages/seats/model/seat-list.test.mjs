// 접근성 좌석 목록의 값 시험(CMP-022, docs/design/d2 CMP-022, docs/frontend.md §5.2, ADR-0227, FE-T18의 키보드 칸).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LIST_STATE_NAMES, flatten, navigate, rowsOf, seatLabel, seatName, seatRowText, seatSelectable, stateName, typeahead } from './seat-list.ts';

const code = (s) => LIST_STATE_NAMES.indexOf(s);
const sections = [
  { section: 0, name: 'A구역', status: 'plenty' },
  { section: 1, name: 'B구역', status: 'soldout' },
];
const open = {
  section: 0,
  baseIndex: 100,
  states: Uint8Array.from([code('available'), code('sold'), code('mine'), code('available')]),
  seats: { seatId: ['a', 'b', 'c', 'd'], row: ['1', '1', '2', '2'], number: ['1', '2', '1', '2'], tier: [0, 0, 1, 1], wheelchair: [3] },
  tiers: ['R', 'S'],
};
const rows = rowsOf(open);
const ids = (ns) => ns.map((n) => n.id);

test('FE-T18 CMP-022 상태 코드 차례가 좌석맵 Worker와 같다', () => {
  const src = readFileSync(new URL('../../../../../../packages/seatmap/src/protocol.ts', import.meta.url), 'utf8');
  assert.ok(src.includes(`LIST_STATES = [${LIST_STATE_NAMES.map((s) => `'${s}'`).join(', ')}] as const`));
});

test('FE-T18 CMP-022 접힌 구역은 구역 줄만, 연 구역은 열, 연 열은 좌석까지 늘어놓고 위치를 싣는다', () => {
  assert.deepEqual(ids(flatten(sections, null, [], new Set())), ['s:0', 's:1']);
  assert.deepEqual(ids(flatten(sections, open, rows, new Set())), ['s:0', 'r:1', 'r:2', 's:1']);
  const all = flatten(sections, open, rows, new Set(['2']));
  assert.deepEqual(ids(all), ['s:0', 'r:1', 'r:2', 'k:2', 'k:3', 's:1']);
  const seat = all[4];
  assert.deepEqual([seat.level, seat.setsize, seat.posinset, seat.parent], [3, 2, 2, 'r:2']);
  const row = all[2];
  assert.deepEqual([row.level, row.setsize, row.posinset, row.expanded, row.available], [2, 2, 2, true, 1]);
  assert.deepEqual([all[5].level, all[5].setsize, all[5].posinset, all[5].expanded], [1, 2, 2, false]);
});

test('FE-T18 CMP-022 ↑↓·Home·End는 보이는 줄을 옮긴다', () => {
  const all = flatten(sections, open, rows, new Set(['2']));
  assert.deepEqual(navigate(all, 'k:2', 'ArrowDown'), { type: 'focus', id: 'k:3' });
  assert.deepEqual(navigate(all, 'k:2', 'ArrowUp'), { type: 'focus', id: 'r:2' });
  assert.equal(navigate(all, 's:1', 'ArrowDown'), null);
  assert.equal(navigate(all, 's:0', 'ArrowUp'), null);
  assert.deepEqual(navigate(all, 'k:2', 'Home'), { type: 'focus', id: 's:0' });
  assert.deepEqual(navigate(all, 'k:2', 'End'), { type: 'focus', id: 's:1' });
});

test('FE-T18 CMP-022 →는 펼치고 첫 자식으로, ←는 접고 부모로 간다. 좌석에는 →가 없다', () => {
  const all = flatten(sections, open, rows, new Set(['2']));
  assert.deepEqual(navigate(all, 'r:1', 'ArrowRight'), { type: 'open', id: 'r:1' });
  assert.deepEqual(navigate(all, 'r:2', 'ArrowRight'), { type: 'focus', id: 'k:2' });
  assert.deepEqual(navigate(all, 's:1', 'ArrowRight'), { type: 'open', id: 's:1' });
  assert.equal(navigate(all, 'k:2', 'ArrowRight'), null);
  assert.deepEqual(navigate(all, 'r:2', 'ArrowLeft'), { type: 'close', id: 'r:2' });
  assert.deepEqual(navigate(all, 'r:1', 'ArrowLeft'), { type: 'focus', id: 's:0' });
  assert.deepEqual(navigate(all, 'k:3', 'ArrowLeft'), { type: 'focus', id: 'r:2' });
  assert.equal(navigate(all, 's:1', 'ArrowLeft'), null);
  // 데이터가 오는 중이라 자식이 없는 펼친 구역은 → 해도 갈 곳이 없다
  assert.equal(navigate([{ kind: 'section', id: 's:9', level: 1, setsize: 1, posinset: 1, parent: null, section: 9, name: 'Z', status: 'few', expanded: true }], 's:9', 'ArrowRight'), null);
});

test('FE-T18 CMP-022 Enter·Space는 실행이고, 처음 들어오면 첫 줄로 간다', () => {
  const all = flatten(sections, open, rows, new Set());
  assert.deepEqual(navigate(all, 'r:1', 'Enter'), { type: 'activate', id: 'r:1' });
  assert.deepEqual(navigate(all, 'r:1', ' '), { type: 'activate', id: 'r:1' });
  assert.deepEqual(navigate(all, null, 'ArrowDown'), { type: 'focus', id: 's:0' });
  assert.equal(navigate([], null, 'ArrowDown'), null);
  assert.equal(navigate(all, 'r:1', 'x'), null);
});

test('FE-T18 CMP-022 글자로 찾기는 지금 줄의 다음부터 한 바퀴 돈다', () => {
  const all = flatten(sections, open, rows, new Set(['2']));
  assert.equal(typeahead(all, open, 's:0', 'b'), 's:1');
  assert.equal(typeahead(all, open, 's:1', 'a'), 's:0');
  assert.equal(typeahead(all, open, 's:0', '2'), 'r:2');
  // 좌석 번호. r:2 다음부터 찾아 '2번'을 고른다
  assert.equal(typeahead(all, open, 'r:2', '2번'), 'k:3');
  assert.equal(typeahead(all, open, 's:0', '없음'), null);
  assert.equal(typeahead(all, open, 's:0', ''), null);
});

test('FE-T18 CMP-022 낭독 이름은 위치·상태·등급·가격을 글자로 담고, 표시 이름은 지도와 같다', () => {
  assert.equal(seatName('A구역', open, 0, 'R석', 150000, false), 'A구역 1열 1번, 예매 가능, R석 ₩150,000');
  assert.equal(seatName('A구역', open, 3, 'S석', 110000, true), 'A구역 2열 2번, 예매 가능, S석 ₩110,000, 휠체어석');
  // 회차 가격표가 오기 전
  assert.equal(seatName('A구역', open, 1, undefined, undefined, false), 'A구역 1열 2번, 판매됨·선택 불가');
  assert.equal(seatLabel('A구역', open, 2), 'A구역 2열 1번');
  // 줄에 보이는 글은 낭독 이름에 그대로 들어 있다(WCAG 2.5.3, axe label-content-name-mismatch)
  const text = seatRowText(open, 3, 'S석', 110000, true);
  assert.equal(text, '2번, 예매 가능, S석 ₩110,000, 휠체어석');
  assert.ok(seatName('A구역', open, 3, 'S석', 110000, true).includes(text));
});

test('FE-T18 CMP-022 고를 수 있는 것은 가능과 내 선택뿐이다', () => {
  assert.deepEqual(LIST_STATE_NAMES.filter(seatSelectable), ['available', 'mine']);
  assert.equal(stateName(open, 2), 'mine');
  // 모르는 코드는 고를 수 없게 본다
  assert.equal(stateName({ ...open, states: Uint8Array.from([200]) }, 0), 'unavailable');
});
