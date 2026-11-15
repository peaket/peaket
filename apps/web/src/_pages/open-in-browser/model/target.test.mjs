// SCR-058 열 주소 규칙 시험(BAT-170 시험 뒤 정한 것, 계획 §11 3, docs/design/d5-screen-blueprint.md §5.32 '열 주소', docs/security/asvs/frontend.md 3.7.2).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). target.ts는 '@/' 별칭으로 고정 자료를 읽어 node로 바로 부르지 못하므로,
// 열 주소 규칙은 순수 함수 open-href.ts에서 보고 target.ts가 그 함수를 쓰는지는 소스로 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openTargetPath } from './open-href.ts';

test('SCR-058 두 꼴의 같은 출처 경로는 고정 자료에 없는 공연·티켓이어도 그대로 연다', () => {
  for (const p of [
    '/queue/evt-lumen-1025',
    '/queue/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e06', // 실제 공연 ID(UUID) 꼴, 고정 자료에 없다
    '/queue/evt-not-in-fixture-9',
    '/my/tickets/tkt-lumen-r1-0312',
    '/my/tickets/0190f3a1-7c2e-7a00-8000-000000000101',
    '/my/tickets/tkt-not-in-fixture-9',
  ]) {
    assert.equal(openTargetPath(p), p, p);
  }
});

test('SCR-058 다른 출처·두 꼴 밖·빈 값은 첫 화면(/)을 연다', () => {
  for (const next of [
    'https://evil.example/queue/x',
    '//evil.example/queue/x',
    '/\evil.example/queue/x',
    'http://localhost:4101/queue/evt-lumen-1025',
    '/queue/x?y',
    '/queue/x#y',
    '/queue/',
    '/queue/x/verify',
    '/my/tickets',
    '/my/tickets/tkt-1/transfer',
    '/my/settings',
    '/',
    '',
    undefined,
    'queue/evt-lumen-1025',
    '/queue/%2F%2Fevil.example',
  ]) {
    assert.equal(openTargetPath(next), '/', String(next));
  }
});

test('SCR-058 안내 화면(target.ts)은 열 주소를 open-href의 규칙으로 정하고 데모 공연으로 바꾸지 않는다', () => {
  const src = readFileSync(new URL('./target.ts', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/open-href(?:\.ts)?'/);
  assert.match(src, /openTargetPath\(/);
  // 모르는 공연을 대표 회차로 바꾸던 길(DEMO_EVENT_ID로 대기실 주소 만들기)이 없다
  assert.doesNotMatch(src, /queueRoomHref\(\s*DEMO_EVENT_ID\s*\)|:\s*DEMO_EVENT_ID;/);
});
