// 로그인 수단 문구(d5 §5.21 SCR-039 '연결 성공', §3.5 세션 종료 사유, BUILD_ORDER BOT-044, ADR-0209).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedText, SESSION_END_TEXT } from './model.ts';

test('I-T75_가입때연결제안의연결성공은다른기기에서는모두로그아웃했다고함께알린다(새맥락리뷰낮음6) [ASVS v5.0.0-7.4.3]', () => {
  assert.equal(linkedText('구글'), '구글 계정을 연결했습니다. 다른 기기에서는 모두 로그아웃했습니다');
  assert.equal(SESSION_END_TEXT.LOGIN_METHOD_CHANGED, '로그인 수단이 바뀌어 이 기기에서 로그아웃되었습니다. 다시 로그인해 주세요');
});
