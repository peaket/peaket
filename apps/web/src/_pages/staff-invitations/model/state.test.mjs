// SCR-050 실제 흐름 화면이 [수락]을 켜고 끄는 판정을 흐름 모듈의 canAcceptIn 하나로 쓰는지 본다(리뷰 RV-01, docs/features/identity.md §12 I-T91 ③,
// ADR-0362 결정 3, BUILD_ORDER F-05-7 시험 담당). 화면 부품(.tsx)은 node로 그리지 못해, 판정의 동작은 흐름 모듈 시험(features/staff-invitation/flow.test.mjs)이 보고
// 여기서는 화면이 그 판정을 실제로 부르는지(따로 만든 조건으로 막지 않는지)를 소스로 본다(settings/model/state.test.mjs와 같은 방법).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canAcceptIn } from '../../../features/staff-invitation/index.ts';

const LIVE = readFileSync(new URL('../ui/StaffInvitationsLive.tsx', import.meta.url), 'utf8');

/** 원문에서 `const name = async () => {` 함수 몸통(닫는 `};`까지) */
function fnBody(src, name) {
  const at = src.indexOf(`const ${name} = async () => {`);
  assert.ok(at >= 0, `${name} 처리기가 있다`);
  return src.slice(at, src.indexOf('\n  };', at));
}

test('I-T91 ③ RV-01 판정 자체: 파트너 이름을 읽지 못함·요약 없음이면 꺼지고 동의 전 + 요약이면 켜진다', () => {
  const invitation = { eventId: 'e', role: 'gate_staff', validFrom: '2026-12-04T04:30:00.000Z', validUntil: '2026-12-04T13:00:00.000Z', invitedEmailMasked: '', consents: { collection: '', provision: '', consentVersion: 'v' } };
  const summary = { eventId: 'e', title: 't', startsAt: '2026-12-04T09:00:00.000Z', sellerName: 's' };
  assert.equal(canAcceptIn({ state: '동의 전', invitation, summary }), true);
  assert.equal(canAcceptIn({ state: '파트너 이름을 읽지 못함', invitation }), false);
  assert.equal(canAcceptIn({ state: '동의 전', invitation }), false);
});

test('I-T91 ③ RV-01 화면의 동의 양식은 canAcceptIn으로 [수락]을 막는다(요약 유무를 따로 보지 않는다)', () => {
  // 양식의 blocked(체크해도 [수락]이 꺼지는 조건)는 흐름 모듈의 판정에서 온다
  assert.match(LIVE, /blocked=\{!canAcceptIn\(load\)\}/);
  assert.doesNotMatch(LIVE, /blocked=\{!summary\}/);
});

test('I-T91 ③ RV-01 화면의 수락 처리기는 canAcceptIn이 거짓이면 요청을 보내지 않는다', () => {
  const accept = fnBody(LIVE, 'accept');
  assert.match(accept, /if \([^)]*!canAcceptIn\(load\)[^)]*\) return;/);
  // 수락 요청은 그 가드 뒤에만 있다
  assert.ok(accept.indexOf('!canAcceptIn(load)') < accept.indexOf('api.accept('), '가드가 요청보다 앞이다');
});
