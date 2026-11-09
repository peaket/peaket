// SCR-004 로그인 화면이 주소에서 읽는 상태(d5 §5.4·§3.5, ADR-0202 결정 4·5, BUILD_ORDER HOT-321)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginView } from './state.ts';

const sp = (s) => Object.fromEntries(new URLSearchParams(s));

test('기본: 안내 없이 세 버튼, 돌아갈 주소는 홈', () => {
  assert.deepEqual(loginView({}), { error: false, down: null, sessionEnd: null, next: '/' });
});

test('로그인 경로가 돌려보낸 실패: error=failed는 카드 위 에러 안내, error=down&provider=는 그 버튼만 제공자 장애', () => {
  assert.deepEqual(loginView(sp('next=%2Fevents%2Fx&error=failed')), { error: true, down: null, sessionEnd: null, next: '/events/x' });
  assert.deepEqual(loginView(sp('next=%2F&error=down&provider=kakao')), { error: false, down: 'kakao', sessionEnd: null, next: '/' });
  // 공급자가 없거나 모르는 값이면 어느 버튼도 막지 않고 일반 에러로 본다
  assert.deepEqual(loginView(sp('error=down&provider=apple')), { error: true, down: null, sessionEnd: null, next: '/' });
  assert.deepEqual(loginView(sp('error=down')), { error: true, down: null, sessionEnd: null, next: '/' });
  // 모르는 error 값은 무시한다
  assert.deepEqual(loginView(sp('error=%3Cscript%3E')), { error: false, down: null, sessionEnd: null, next: '/' });
});

test('세션 종료 사유는 팬 사유 일곱만 받고 모르는 값은 무시한다(LOGIN_METHOD_CHANGED는 2026-11-05 BOT-044, ADR-0209)', () => {
  for (const r of ['LOGOUT', 'ADMIN_FORCE', 'REFRESH_REUSE', 'DEVICE_LIMIT', 'MERGED', 'DELETE', 'LOGIN_METHOD_CHANGED']) assert.equal(loginView(sp(`ended=${r}`)).sessionEnd, r);
  for (const r of ['ROLE_CHANGED', 'logout', '', 'PASSWORD_CHANGED']) assert.equal(loginView(sp(`ended=${r}`)).sessionEnd, null, r);
});

test('돌아갈 주소는 같은 출처 경로만 받는다(safeNext, FE-T12) [ASVS v5.0.0-3.7.2]', () => {
  for (const bad of ['//evil.example', 'https://evil.example/', '/\\evil', '/%2f%2fevil', 'javascript:alert(1)']) assert.equal(loginView({ next: bad }).next, '/', bad);
  assert.equal(loginView({ next: ['/a', '/b'] }).next, '/a', '여러 값이면 첫 값');
});
