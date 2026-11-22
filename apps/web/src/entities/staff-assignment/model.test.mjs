// 내 현장 배정의 배지·칸 계산 시험(SCR-061, d5 §5.35 '배지와 칸', docs/features/identity.md §12 I-T93 ①②, BUILD_ORDER F-05-7 시험 담당).
// 경계 값(시작·끝 정각과 1ms)은 I-T93 ①의 글에서 가져왔다. 배지 글은 d5 §5.35의 네 이름이다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCurrentAssignment, STAFF_PHASE_LABEL, staffAssignmentSelfOf, staffPhaseAt } from './index.ts';

const FROM = Date.parse('2026-12-04T04:30:00.000Z');
const UNTIL = Date.parse('2026-12-04T13:00:00.000Z');
const row = (status, o = {}) => ({ status, validFrom: new Date(FROM).toISOString(), validUntil: new Date(UNTIL).toISOString(), ...o });

test('I-T93 ① 시작 정각은 진행 중이고 1ms 전은 곧 시작이다', () => {
  assert.equal(staffPhaseAt(row('ASSIGNED'), FROM - 1), 'soon');
  assert.equal(staffPhaseAt(row('ASSIGNED'), FROM), 'active');
});

test('I-T93 ① 끝 정각은 진행 중이고 1ms 뒤는 종료다', () => {
  assert.equal(staffPhaseAt(row('ASSIGNED'), UNTIL), 'active');
  assert.equal(staffPhaseAt(row('ASSIGNED'), UNTIL + 1), 'ended');
});

test('I-T93 ① ENDED는 언제나 종료, REVOKED는 언제나 해제이고 배지 글은 곧 시작·진행 중·종료·해제다', () => {
  for (const t of [FROM - 1, FROM, UNTIL, UNTIL + 1]) {
    assert.equal(staffPhaseAt(row('ENDED'), t), 'ended');
    assert.equal(staffPhaseAt(row('REVOKED'), t), 'revoked');
  }
  assert.deepEqual(
    ['soon', 'active', 'ended', 'revoked'].map((p) => STAFF_PHASE_LABEL[p]),
    ['곧 시작', '진행 중', '종료', '해제'],
  );
});

test('I-T93 ② 곧 시작·진행 중과 validUntil이 지나지 않은 해제는 현재 배정, 나머지는 지난 배정이다', () => {
  assert.equal(isCurrentAssignment(row('ASSIGNED'), FROM - 1), true);
  assert.equal(isCurrentAssignment(row('ASSIGNED'), UNTIL), true);
  assert.equal(isCurrentAssignment(row('ASSIGNED'), UNTIL + 1), false);
  assert.equal(isCurrentAssignment(row('REVOKED'), UNTIL), true);
  assert.equal(isCurrentAssignment(row('REVOKED'), UNTIL + 1), false);
  assert.equal(isCurrentAssignment(row('ENDED'), FROM), false);
});

test('I-T93 응답 한 줄(openapi StaffAssignmentSelf)은 모양이 맞을 때만 읽고 빈 기기 이름은 null이다', () => {
  const ok = { assignmentId: 'a', eventId: 'e', role: 'gate_lead', status: 'ASSIGNED', validFrom: '2026-12-04T04:30:00.000Z', validUntil: '2026-12-04T13:00:00.000Z', activeScannerDeviceName: '서문-14' };
  assert.deepEqual(staffAssignmentSelfOf(ok), ok);
  assert.equal(staffAssignmentSelfOf({ ...ok, activeScannerDeviceName: '' }).activeScannerDeviceName, null);
  assert.equal(staffAssignmentSelfOf({ ...ok, activeScannerDeviceName: undefined }).activeScannerDeviceName, null);
  assert.equal(staffAssignmentSelfOf({ ...ok, status: 'INVITED' }), null);
  assert.equal(staffAssignmentSelfOf({ ...ok, role: 'admin' }), null);
  assert.equal(staffAssignmentSelfOf({ ...ok, validFrom: 'x' }), null);
});
