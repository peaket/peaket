// 머리 검색창 자동완성 창 모양(d5 §5.3, BUILD_ORDER HOT-313)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPopupMode } from './search-mode.ts';

const base = { preview: null, q: '루멘', recentCount: 2, async: true, remote: null, syncCount: 0 };

test('입력 전에는 최근 검색어(없으면 닫힘), 미리보기 상태는 그대로', () => {
  assert.equal(searchPopupMode({ ...base, q: '' }), 'recent');
  assert.equal(searchPopupMode({ ...base, q: '', recentCount: 0 }), 'closed');
  assert.equal(searchPopupMode({ ...base, preview: 'none' }), 'none');
});

test('비동기 출처: 지금 검색어의 답이 없거나 불러오는 중이면 뼈대, 답이 오면 후보·후보 없음, 실패·off면 창 없음', () => {
  assert.equal(searchPopupMode(base), 'loading');
  assert.equal(searchPopupMode({ ...base, remote: { q: '루', status: 'ready', count: 3 } }), 'loading', '앞선 검색어의 답은 쓰지 않는다');
  assert.equal(searchPopupMode({ ...base, remote: { q: '루멘', status: 'loading', count: 0 } }), 'loading');
  assert.equal(searchPopupMode({ ...base, remote: { q: '루멘', status: 'ready', count: 3 } }), 'suggest');
  assert.equal(searchPopupMode({ ...base, remote: { q: '루멘', status: 'ready', count: 0 } }), 'none');
  assert.equal(searchPopupMode({ ...base, remote: { q: '루멘', status: 'error', count: 0 } }), 'closed');
  assert.equal(searchPopupMode({ ...base, remote: { q: '루멘', status: 'off', count: 0 } }), 'closed');
});

test('동기 후보(이야기·퍼블리싱)는 후보 수로 고른다', () => {
  assert.equal(searchPopupMode({ ...base, async: false, syncCount: 2 }), 'suggest');
  assert.equal(searchPopupMode({ ...base, async: false, syncCount: 0 }), 'none');
});
