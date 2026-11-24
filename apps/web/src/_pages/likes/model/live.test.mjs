// IR-06 재현 시험(F-05-8 구현 리뷰, 통과 기준): 실서버 화면의 탭 배지는 실제 목록 수만 쓴다.
// 로딩·빈 목록·오류·로그인 안내에는 숫자를 붙이지 않는다(목업 수 금지, plan §8 #2·§4, d5 §5.28).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveLikesBadge } from './live.ts';

const MOCK_FIVE = Array.from({ length: 5 }, (_, i) => ({
  id: `mock-${i}`,
  title: `목업 ${i}`,
  sub: '',
  badgeText: '판매 중',
  badgeCls: 'badge',
}));

test('IR-06 실서버 화면 배지는 실제 목록 수만 쓰고 로딩·빈·오류·비로그인에는 숫자가 없다', () => {
  assert.equal(liveLikesBadge('loading', MOCK_FIVE), undefined);
  assert.equal(liveLikesBadge('error', MOCK_FIVE), undefined);
  assert.equal(liveLikesBadge('guest', MOCK_FIVE), undefined);
  assert.equal(liveLikesBadge('ready', []), undefined);
  assert.equal(liveLikesBadge('ready', MOCK_FIVE.slice(0, 2)), 2);
  assert.equal(liveLikesBadge('ready', MOCK_FIVE), 5);
});
