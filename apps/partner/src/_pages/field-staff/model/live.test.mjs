// GAT-360 파트너 SCR-037 실제 명단·초대 해석 시험(시험 먼저).
// identity-svc의 GET /v1/partner/events/{eventId}/staff, POST .../staff-invitations 계약 모양만 읽는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationInputOf, staffRowsOf } from './live.ts';

test('GAT-360 명단 응답을 닉네임·역할·상태·유효 시간 행으로 옮기고 이메일·계정 ID는 쓰지 않는다', () => {
  const rows = staffRowsOf({
    items: [
      { assignmentId: 'a1', eventId: 'e1', nickname: '도윤', role: 'gate_lead', status: 'ASSIGNED', validFrom: '2026-10-25T06:30:00Z', validUntil: '2026-10-25T13:00:00Z', inviteExpiresAt: '2026-10-24T10:00:00Z', email: 'secret@example.com', accountId: 'acc-secret' },
      { assignmentId: 'a2', eventId: 'e1', role: 'gate_staff', status: 'INVITED', inviteExpiresAt: '2026-10-25T10:00:00Z', email: 'invited@example.com' },
      { assignmentId: 'a3', eventId: 'e1', nickname: '민호', role: 'gate_staff', status: 'REVOKED' },
    ],
    nextCursor: null,
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: 'a1',
    nickname: '도윤',
    role: '현장 책임자',
    status: '수락',
    validity: '10. 25. 15:30 ~ 10. 25. 22:00 KST',
    canResend: false,
    canRevoke: true,
  });
  assert.equal(rows[1].nickname, null);
  assert.equal(rows[1].role, '현장 스태프');
  assert.equal(rows[1].status, '초대 중');
  assert.equal(rows[1].canResend, true);
  assert.equal(rows[1].canRevoke, true);
  assert.equal(rows[2].status, '해제');
  assert.ok(!JSON.stringify(rows).includes('secret@example.com'));
  assert.ok(!JSON.stringify(rows).includes('acc-secret'));
});

test('GAT-360 초대 입력은 줄 단위 이메일을 검사하고 같은 이메일·형식 오류를 행 번호와 함께 돌려준다', () => {
  assert.deepEqual(invitationInputOf('a@example.com\n\n B@Example.com \nb@example.com\nnot-an-email\n'), {
    invitations: [{ email: 'a@example.com', role: 'gate_staff' }, { email: 'B@Example.com', role: 'gate_staff' }],
    errors: [
      { line: 4, input: 'b@example.com', reason: '같은 이메일이 이미 있습니다' },
      { line: 5, input: 'not-an-email', reason: '이메일 형식이 아닙니다' },
    ],
  });
  assert.deepEqual(invitationInputOf('', 'gate_lead'), { invitations: [], errors: [{ line: 0, input: '', reason: '초대할 이메일을 한 개 이상 적어 주세요' }] });
});
