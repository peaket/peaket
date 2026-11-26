// SCR-046 승인 업무 화면의 값 해석 시험(F-06-3 GAT-290·GAT-300, 시험 담당, 2026-11-26).
// 정본: docs/design/d5-screen-blueprint.md §7.7, docs/features/transfer-refund.md §7.2, docs/features/settlement.md §9,
// docs/api/openapi.yaml ApprovalRequest·PayoutBatch.payeeDigest, docs/api/guidelines.md '판·ETag'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalPageOf, approvalViewOf, canAct, digestMatches, errorOf, evidenceOf, ifMatchOf, kindLabel, payeeDigestOf, quorumLabel, statusOf, versionOfEtag } from './live.ts';

const BASE = {
  approvalId: '0194f063-0000-7000-8000-000000000001',
  kind: 'SETTLEMENT_ADJUSTMENT',
  targetRef: 'statement-1',
  amount: 30_000,
  reasonCode: 'OTHER',
  reasonText: '근거 메모',
  evidenceChecked: null,
  requiredApprovals: 2,
  approvals: [],
  status: 'PENDING_APPROVAL',
  requestedBy: { adminAccountId: 'admin-1', displayName: null, role: 'cs_lead' },
  requestedAt: '2026-11-26T01:00:00.000Z',
  canApprove: true,
  dueAt: null,
  closeReason: null,
  payeeDigest: null,
  version: 3,
};

test('알 수 없는 칸은 버리고 화면이 쓰는 칸만 남긴다', () => {
  const v = approvalViewOf({ ...BASE, payerName: '홍길동', phone: '010-0000-0000', bankAccount: '123-456', nested: { x: 1 }, requiredApprovals: 2, evidenceChecked: 'PHONE_VERIFICATION', version: 7 });
  assert.ok(v);
  for (const k of ['payerName', 'phone', 'bankAccount', 'nested']) assert.equal(k in v, false, k);
  assert.equal(v.approvalId, BASE.approvalId);
  assert.equal(v.amount, 30_000);
  assert.equal(v.requiredApprovals, 2);
  assert.equal(v.evidenceChecked, 'PHONE_VERIFICATION');
  assert.equal(v.version, 7);
});

test('1·2인 배지는 요청자 말고 필요한 승인 인원으로 읽는다', () => {
  assert.equal(quorumLabel(2), '1인 승인');
  assert.equal(quorumLabel(3), '2인 승인');
  assert.equal(quorumLabel(1), '승인 없음');
  assert.equal(quorumLabel(9), null);
});

test('증빙은 확인한 종류만 보이고 파일·내용은 보이지 않는다', () => {
  assert.equal(evidenceOf({ evidenceChecked: 'DOCUMENT:진단서', evidenceFile: 'x' }), '서류: 진단서');
  assert.equal(evidenceOf({ evidenceChecked: 'PHONE_VERIFICATION' }), '휴대폰 본인확인 대조');
  assert.equal(evidenceOf({}), null);
  assert.equal(evidenceOf({ evidenceChecked: 'OTHER' }), 'OTHER');
});

test('필수 칸이 빠지거나 모르는 종류·상태면 그 줄을 버린다', () => {
  assert.equal(approvalViewOf(null), null);
  assert.equal(approvalViewOf({ ...BASE, approvalId: '' }), null);
  assert.equal(approvalViewOf({ ...BASE, kind: 'UNKNOWN_KIND' }), null);
  assert.equal(approvalViewOf({ ...BASE, status: 'CLOSED' }), null);
  assert.equal(approvalViewOf({ ...BASE, requiredApprovals: 9 }), null);
});

test('목록은 받은 항목만 남기고 nextCursor를 그대로 준다', () => {
  const page = approvalPageOf({ items: [BASE, { ...BASE, status: 'X' }, 'row', { ...BASE, approvalId: '0194f063-0000-7000-8000-000000000002' }], nextCursor: 'abc', secret: 1 });
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, 'abc');
  assert.equal('secret' in page, false);
});

test('종류 이름은 열두 가지를 한국어로 읽고 모르는 값은 그대로 보인다', () => {
  assert.equal(kindLabel('SYSTEM_FAULT_REFUND'), '시스템 잘못 환불');
  assert.equal(kindLabel('DISCRETIONARY_WAIVER'), '재량 면제');
  assert.equal(kindLabel('TRANSFER_RECLAIM'), '양도 회수');
  assert.equal(kindLabel('MINOR_CONTRACT_CANCEL'), '미성년자 계약 취소');
  assert.equal(kindLabel('PAYOUT_BATCH'), '지급 묶음');
  assert.equal(kindLabel('SETTLEMENT_ADJUSTMENT'), '정산서 수기 조정');
  assert.equal(kindLabel('FRAUD_ACTION'), '부정 예매 조치');
  assert.equal(kindLabel('X'), 'X');
});

test('상태 배지는 지급·승인 공통 열 가지를 읽는다', () => {
  assert.equal(statusOf('PENDING_APPROVAL'), '승인 대기');
  assert.equal(statusOf('ESCALATED'), '상위 알림');
  assert.equal(statusOf('WITHDRAWN'), '철회');
  assert.equal(statusOf('EXPIRED'), '만료');
  assert.equal(statusOf('DONE'), '완료');
  assert.equal(statusOf('FAILED'), '실패');
});

test('요청자·역할·상태로 승인·반려·철회 버튼을 가른다', () => {
  const asLead = canAct({ ...BASE, canApprove: true }, { accountId: 'lead-1', role: 'cs_lead' });
  assert.deepEqual(asLead, { approve: true, reject: true, withdraw: false });
  const requester = canAct({ ...BASE, requestedBy: { ...BASE.requestedBy, adminAccountId: 'lead-1' } }, { accountId: 'lead-1', role: 'cs_lead' });
  assert.deepEqual(requester, { approve: false, reject: false, withdraw: true });
  const commander = canAct({ ...BASE, status: 'ESCALATED' }, { accountId: 'cmd-1', role: 'commander' });
  assert.deepEqual(commander, { approve: true, reject: true, withdraw: false });
  const done = canAct({ ...BASE, status: 'DONE' }, { accountId: 'cmd-1', role: 'commander' });
  assert.deepEqual(done, { approve: false, reject: false, withdraw: false });
  const failed = canAct({ ...BASE, status: 'FAILED', canApprove: true }, { accountId: 'cmd-1', role: 'commander' });
  assert.deepEqual(failed, { approve: true, reject: true, withdraw: false });
});

test('오류 응답을 화면 문구로 옮긴다(만료·대상 변경·자기 승인·역할·소명 기한·지문)', () => {
  assert.deepEqual(errorOf({ type: 'https://peaket.example/problems/approval-expired', status: 409 }, 409), { kind: 'expired', text: '승인 기한이 지나 만료되었습니다' });
  assert.deepEqual(errorOf({ type: 'https://peaket.example/problems/approval-target-changed', status: 409 }, 409), { kind: 'target-changed', text: '대상이 바뀌어 승인할 수 없습니다' });
  assert.deepEqual(errorOf({ type: 'https://peaket.example/problems/approval-self-not-allowed', status: 403 }, 403), { kind: 'self', text: '요청한 분은 승인할 수 없습니다' });
  assert.deepEqual(errorOf({ type: 'https://peaket.example/problems/approval-role-required', status: 403 }, 403), { kind: 'role', text: '이 업무를 승인할 역할이 아닙니다' });
  assert.deepEqual(errorOf({ type: 'https://peaket.example/problems/reclaim-appeal-window', status: 409 }, 409), { kind: 'appeal-window', text: '받은 분의 소명 기한이 지난 뒤에 승인할 수 있습니다' });
  assert.deepEqual(errorOf({ type: 'https://peaket.example/problems/payout-batch-payee-mismatch', status: 409 }, 409), { kind: 'payee-mismatch', text: '지급 대상이 바뀌었습니다. 다시 불러와 확인해 주세요' });
});

test('지급 대상 지문은 64자 소문자 16진만 받고 다르면 false다', () => {
  const a = 'a'.repeat(64);
  assert.equal(payeeDigestOf({ payeeDigest: a }), a);
  assert.equal(payeeDigestOf({ payeeDigest: 'A'.repeat(64) }), null);
  assert.equal(payeeDigestOf({ payeeDigest: 'a'.repeat(63) }), null);
  assert.equal(payeeDigestOf({ payeeDigest: null }), null);
  assert.equal(digestMatches(a, 'a'.repeat(64)), true);
  assert.equal(digestMatches(a, 'b'.repeat(64)), false);
  assert.equal(digestMatches(a, null), false);
});

test('판은 ETag에서 읽고 If-Match 꼴로 만든다', () => {
  assert.equal(versionOfEtag('"3"'), 3);
  assert.equal(versionOfEtag(null), null);
  assert.equal(versionOfEtag('3'), null);
  assert.equal(ifMatchOf(3), '"3"');
  assert.equal(ifMatchOf(null), null);
});
