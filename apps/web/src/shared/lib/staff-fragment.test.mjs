// 현장 스태프 화면 주소의 비밀 조각(초대 #token=, 스캐너 승인 #code=) 규칙 시험(docs/features/identity.md §12 I-T47, d5 §5.26·§5.27 끝 문단,
// docs/frontend.md §3.12 `peaket.staff.fragment`(10분 [가정]), ADR-0065 결정 10, BUILD_ORDER F-05-7 시험 담당).
// 경계(location·history·세션 저장소)만 가짜로 둔다. 키 이름·10분은 docs/frontend.md §3.12의 값을 글로 적었다(코드 상수를 가져오지 않는다).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureStaffFragment, clearStaffFragment, fragmentValue, keepStaffFragment, staffLoginHref, takeStaffFragment } from './staff-fragment.ts';

const KEY = 'peaket.staff.fragment';
const TEN_MIN = 10 * 60_000;
const NOW = Date.parse('2026-12-04T08:00:00.000Z');

const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};
const fakeHistory = () => {
  const urls = [];
  return { replaceState: (_d, _u, url) => void urls.push(url), urls };
};

test('I-T47 조각은 읽자마자 주소에서 지워지고 next에는 경로만 실린다 [ASVS v5.0.0-3.4.5] [ASVS v5.0.0-14.2.1]', () => {
  const storage = memoryStore();
  const history = fakeHistory();
  captureStaffFragment({ kind: 'invite', location: { hash: '#token=inv-Secret_43chars', pathname: '/staff/invitations', search: '' }, history, storage, now: NOW });
  // 주소창은 경로만 남는다(replaceState라 뒤로 가기 기록에도 조각이 없다)
  assert.deepEqual(history.urls, ['/staff/invitations']);
  // 값은 이 탭의 저장소에 {kind, value, at}로만
  assert.deepEqual(JSON.parse(storage.m.get(KEY)), { kind: 'invite', value: 'inv-Secret_43chars', at: NOW });
  // 로그인하러 갈 때 next에는 경로만(조각·쿼리·토큰 없음)
  for (const path of ['/staff/invitations', '/staff/approve', '/staff']) {
    const href = staffLoginHref(path);
    const u = new URL(href, 'https://www.peaket.test');
    assert.equal(u.pathname, '/login');
    assert.equal(u.hash, '');
    assert.deepEqual([...u.searchParams.keys()], ['next']);
    assert.equal(u.searchParams.get('next'), path);
    assert.ok(!href.includes('inv-Secret'), href);
  }
});

test('I-T47 승인 조각(#code=)도 같은 규칙이고 쿼리는 남기며, 값이 틀린 조각과 빈 # 도 주소에서 지운다 [ASVS v5.0.0-3.4.5]', () => {
  const storage = memoryStore();
  const history = fakeHistory();
  captureStaffFragment({ kind: 'approve', location: { hash: '#code=KQRT-ZPLM', pathname: '/staff/approve', search: '?from=qr' }, history, storage, now: NOW });
  assert.deepEqual(history.urls, ['/staff/approve?from=qr']);
  assert.deepEqual(JSON.parse(storage.m.get(KEY)), { kind: 'approve', value: 'KQRT-ZPLM', at: NOW });
  // 다른 이름의 조각: 저장하지 않지만 주소에서는 지운다
  const s2 = memoryStore();
  const h2 = fakeHistory();
  captureStaffFragment({ kind: 'approve', location: { hash: '#token=nope', pathname: '/staff/approve', search: '' }, history: h2, storage: s2, now: NOW });
  assert.deepEqual(h2.urls, ['/staff/approve']);
  assert.equal(s2.m.size, 0);
  const h3 = fakeHistory();
  captureStaffFragment({ kind: 'invite', location: { hash: '#', pathname: '/staff/invitations', search: '' }, history: h3, storage: memoryStore(), now: NOW });
  assert.deepEqual(h3.urls, ['/staff/invitations']);
  // 조각이 없으면 주소를 건드리지 않는다
  const h4 = fakeHistory();
  captureStaffFragment({ kind: 'invite', location: { hash: '', pathname: '/staff/invitations', search: '' }, history: h4, storage: memoryStore(), now: NOW });
  assert.deepEqual(h4.urls, []);
});

test('I-T47 조각 값 읽기: 그 화면의 이름만, 빈 값은 없음', () => {
  assert.equal(fragmentValue('#token=abc', 'invite'), 'abc');
  assert.equal(fragmentValue('token=abc', 'invite'), 'abc');
  assert.equal(fragmentValue('#token=abc', 'approve'), null);
  assert.equal(fragmentValue('#code=', 'approve'), null);
  assert.equal(fragmentValue('', 'invite'), null);
});

test('I-T47 탭 저장소 값은 남긴 지 10분 정각까지 쓰고 1ms 뒤에는 지운다. 남긴 시각이 지금보다 뒤면 버린다 [ASVS v5.0.0-14.3.3]', () => {
  const at = (v) => {
    const s = memoryStore();
    s.set(KEY, JSON.stringify({ kind: 'invite', value: 'tok-x', at: v }));
    return s;
  };
  const exact = at(NOW - TEN_MIN);
  assert.equal(takeStaffFragment(exact, 'invite', NOW), 'tok-x');
  // 꺼내도 지우지 않는다(조회가 성공해야 지운다)
  assert.equal(exact.m.has(KEY), true);
  const late = at(NOW - TEN_MIN - 1);
  assert.equal(takeStaffFragment(late, 'invite', NOW), null);
  assert.equal(late.m.has(KEY), false);
  const future = at(NOW + 1);
  assert.equal(takeStaffFragment(future, 'invite', NOW), null);
  assert.equal(future.m.has(KEY), false);
  // 모양이 틀리면 지운다
  const bad = memoryStore();
  bad.set(KEY, '{not json');
  assert.equal(takeStaffFragment(bad, 'invite', NOW), null);
  assert.equal(bad.m.has(KEY), false);
});

test('I-T47 화면은 자기 kind만 꺼내고 지운다. 다른 화면의 값은 그대로 둔다 [ASVS v5.0.0-14.3.3]', () => {
  const s = memoryStore();
  s.set(KEY, JSON.stringify({ kind: 'approve', value: 'KQRT-ZPLM', at: NOW }));
  assert.equal(takeStaffFragment(s, 'invite', NOW), null);
  clearStaffFragment(s, 'invite');
  assert.deepEqual(JSON.parse(s.m.get(KEY)), { kind: 'approve', value: 'KQRT-ZPLM', at: NOW });
  assert.equal(takeStaffFragment(s, 'approve', NOW), 'KQRT-ZPLM');
  clearStaffFragment(s, 'approve');
  assert.equal(s.m.has(KEY), false);
});

test('I-T47 로그인하러 떠나기 전 되돌려 둔 값은 지금 시각으로 남아 돌아와 같은 탭에서 잇는다', () => {
  const s = memoryStore();
  keepStaffFragment(s, 'invite', 'tok-back', NOW);
  assert.deepEqual(JSON.parse(s.m.get(KEY)), { kind: 'invite', value: 'tok-back', at: NOW });
  assert.equal(takeStaffFragment(s, 'invite', NOW + TEN_MIN), 'tok-back');
  assert.equal(takeStaffFragment(s, 'invite', NOW + TEN_MIN + 1), null);
  // 빈 값은 남기지 않는다
  const e = memoryStore();
  keepStaffFragment(e, 'invite', '', NOW);
  assert.equal(e.m.size, 0);
});
