// 재인증 강도 판정(docs/features/identity.md §7.1 표와 '재인증 흐름과 토큰' ②, I-T54, ASVS v5.0.0-6.8.4).
// `pnpm --filter @peaket/web test`가 타입 지우기로 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reauthPrompt, reauthStrength } from './reauth-strength.ts';

const START = Date.parse('2026-11-03T03:00:00Z');
const sec = (ms) => Math.floor(ms / 1000);

test('I-T54_① 카카오 auth_time이 재인증 시작 뒤면 확인됨이다', () => {
  assert.equal(reauthStrength('kakao', { auth_time: sec(START + 20_000) }, START, START + 30_000), 'verified');
  // 시계 차이 30초까지 봐준다
  assert.equal(reauthStrength('kakao', { auth_time: sec(START - 29_000) }, START, START + 30_000), 'verified');
});

test('I-T54_② 카카오 auth_time이 시작보다 이르거나 없으면 거부다', () => {
  assert.equal(reauthStrength('kakao', { auth_time: sec(START - 31_000) }, START, START + 30_000), 'stale');
  assert.equal(reauthStrength('kakao', {}, START, START + 30_000), 'stale');
});

test('I-T54_③ 네이버는 auth_time이 없어 iat가 시작 뒤면 요청만 함이다', () => {
  assert.equal(reauthStrength('naver', { iat: sec(START + 5_000) }, START, START + 6_000), 'requested');
  // auth_time을 보내도 설정 정보에 없는 클레임이라 쓰지 않는다
  assert.equal(reauthStrength('naver', { iat: sec(START + 5_000), auth_time: sec(START + 5_000) }, START, START + 6_000), 'requested');
  // 이번 요청의 응답이 아니면(iat가 시작보다 이름) 거부
  assert.equal(reauthStrength('naver', { iat: sec(START - 60_000) }, START, START + 6_000), 'stale');
  assert.equal(reauthStrength('naver', {}, START, START + 6_000), 'stale');
});

test('I-T54_구글 auth_time이 5분 안이면 확인됨, 더 이르면 거부, 없으면 요청만 함이다', () => {
  const now = START + 10_000;
  assert.equal(reauthStrength('google', { auth_time: sec(now - 4 * 60_000), iat: sec(now) }, START, now), 'verified');
  assert.equal(reauthStrength('google', { auth_time: sec(now - 5 * 60_000 - 29_000), iat: sec(now) }, START, now), 'verified');
  assert.equal(reauthStrength('google', { auth_time: sec(now - 5 * 60_000 - 31_000), iat: sec(now) }, START, now), 'stale');
  assert.equal(reauthStrength('google', { iat: sec(now) }, START, now), 'requested');
});

test('I-T54_제공자마다 다시 로그인 강제 값을 보낸다', () => {
  assert.deepEqual(reauthPrompt('kakao'), { prompt: 'login' });
  assert.deepEqual(reauthPrompt('naver'), { prompt: 'login' });
  assert.deepEqual(reauthPrompt('google'), { prompt: 'select_account', claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) });
});
