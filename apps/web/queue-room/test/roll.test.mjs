// SCR-008 ① 앞 인원 숫자 굴림(d5 §5.8 lg '숫자를 굴리는 모션'): 바뀐 자리만 굴리고, 자릿수가 바뀌면 오른쪽 끝을 맞춰 견준다
import test from 'node:test';
import assert from 'node:assert/strict';
import { rollDigits } from '../src/ui/roll.ts';

test('SCR-008 앞 인원 굴림: 처음 그릴 때는 굴리지 않는다', () => {
  assert.deepEqual(rollDigits('3,214', undefined), [{ ch: '3' }, { ch: ',' }, { ch: '2' }, { ch: '1' }, { ch: '4' }]);
});

test('SCR-008 앞 인원 굴림: 바뀐 자리만 앞 글자를 함께 둔다', () => {
  assert.deepEqual(rollDigits('3,209', '3,214'), [{ ch: '3' }, { ch: ',' }, { ch: '2' }, { ch: '0', old: '1' }, { ch: '9', old: '4' }]);
});

test('SCR-008 앞 인원 굴림: 같은 값이면 하나도 굴리지 않는다', () => {
  assert.ok(rollDigits('18', '18').every((d) => d.old === undefined));
});

test('SCR-008 앞 인원 굴림: 자릿수가 줄면 오른쪽 끝을 맞춰 견준다(1,000 → 999)', () => {
  assert.deepEqual(rollDigits('999', '1,000'), [{ ch: '9', old: '0' }, { ch: '9', old: '0' }, { ch: '9', old: '0' }]);
});

test('SCR-008 앞 인원 굴림: 자릿수가 늘면 새로 생긴 자리는 빈 글자에서 굴린다', () => {
  assert.deepEqual(rollDigits('10', '9'), [{ ch: '1', old: '' }, { ch: '0', old: '9' }]);
});
