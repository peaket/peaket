// SCR-046 계약 조건 변경 승인 카드의 표시·판정 시험(F-07-2, d5 §7.7·§7.13, settlement §9·§10, ADR-0060).
// 서버의 2인 승인(요청자가 아닌 commander, 재인증)을 화면이 그대로 따르는지 순수 함수로 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  approvalBodyOf,
  approvalEligibility,
  approvalMetaOf,
  contractApprovalProblemMessage,
  contractRowsOf,
  isContractApproval,
  rejectionBodyOf,
  REJECTION_REASON_MAX,
} from './contract-approval.ts';

const TERMS = {
  current: { commissionRateBp: 1000, guaranteeRateBp: 1000, guaranteeKind: 'DEPOSIT', validFrom: '2026-10-01T00:00:00.000Z', validUntil: null, approvalId: null },
  requestedCommissionRateBp: 875,
  requestedGuaranteeRateBp: null,
  requestedGuaranteeKind: 'PERFORMANCE_BOND',
};

test('CON-APR ① 계약 변경 요청의 현재 값과 바꿀 값을 10,000bp=100%로 나란히 보인다', () => {
  assert.deepEqual(contractRowsOf(TERMS), [
    { label: '중개수수료율', current: '10%', requested: '8.75%', changed: true },
    { label: '계약 보증', current: '10%', requested: '10%', changed: false },
    { label: '보증 종류', current: '보증금', requested: '이행보증보험', changed: true },
  ]);
  // 바꿀 칸을 하나도 보내지 않은 요청은 서버가 422로 거절하지만, 표시 함수는 지금 값 그대로를 보인다
  assert.deepEqual(
    contractRowsOf({ current: TERMS.current, requestedCommissionRateBp: null, requestedGuaranteeRateBp: null, requestedGuaranteeKind: null }).map((r) => r.changed),
    [false, false, false],
  );
});

test('CON-APR ② 요청자 본인·다른 역할은 승인할 수 없고, 요청자가 아닌 commander만 승인한다', () => {
  const pending = { status: 'PENDING_APPROVAL', requestedBy: { adminAccountId: 'adm-1', displayName: '도윤', role: 'operator' } };
  assert.deepEqual(approvalEligibility(pending, { accountId: 'adm-2', role: 'commander' }), { canApprove: true });
  assert.deepEqual(approvalEligibility(pending, { accountId: 'adm-1', role: 'commander' }), { canApprove: false, reason: '요청한 분은 승인할 수 없습니다.' });
  for (const role of ['operator', 'cs_lead', 'cs_agent', 'viewer']) {
    const r = approvalEligibility(pending, { accountId: 'adm-2', role });
    assert.equal(r.canApprove, false, role);
    assert.match(r.reason, /승인할 수 없습니다/);
  }
  assert.equal(approvalEligibility({ ...pending, status: 'APPROVED' }, { accountId: 'adm-2', role: 'commander' }).canApprove, false);
});

test('CON-APR ③ 계약 변경만 이 카드가 다루고, 다른 승인 종류는 각자 화면이 맡는다', () => {
  assert.equal(isContractApproval({ kind: 'CONTRACT_TERMS_CHANGE', status: 'PENDING_APPROVAL' }), true);
  assert.equal(isContractApproval({ kind: 'CONTRACT_TERMS_CHANGE', status: 'APPROVED' }), false);
  assert.equal(isContractApproval({ kind: 'SETTLEMENT_ADJUSTMENT', status: 'PENDING_APPROVAL' }), false);
  assert.equal(isContractApproval({ kind: 'FRAUD_ACTION', status: 'PENDING_APPROVAL' }), false);
});

test('CON-APR ④ 승인·반려 본문을 정본 모양으로 만들고, 반려 사유가 비면 보내지 않는다', () => {
  assert.deepEqual(approvalBodyOf(), {});
  assert.deepEqual(approvalBodyOf('  '), {});
  assert.deepEqual(approvalBodyOf(' 계약 갱신 조건을 확인했습니다 '), { reason: '계약 갱신 조건을 확인했습니다' });
  assert.equal(rejectionBodyOf(''), undefined);
  assert.equal(rejectionBodyOf('   '), undefined);
  assert.equal(rejectionBodyOf('x'.repeat(REJECTION_REASON_MAX + 1)), undefined);
  assert.deepEqual(rejectionBodyOf(' 보증 종류를 다시 협의해야 합니다 '), { reason: '보증 종류를 다시 협의해야 합니다' });
});

test('CON-APR ⑤ 재인증 만료·요청자 본인·먼저 처리됨을 상태별 문구로 보인다', () => {
  assert.match(contractApprovalProblemMessage({ status: 403, type: 'reauth-required' }), /재인증이 만료/);
  assert.match(contractApprovalProblemMessage({ status: 403 }), /요청한 분은 승인할 수 없습니다/);
  assert.match(contractApprovalProblemMessage({ status: 409 }), /다른 사람이 먼저 처리/);
  assert.match(contractApprovalProblemMessage({ status: 422 }), /반려는 사유가 필요/);
  assert.match(contractApprovalProblemMessage({ status: 503 }), /연결하지 못했습니다/);
  assert.match(contractApprovalProblemMessage({ status: 404 }), /열 수 없습니다/);
  assert.match(contractApprovalProblemMessage(new Error('network')), /보내지 못했습니다/);
  assert.match(approvalMetaOf({ requestedBy: { adminAccountId: 'adm-1', displayName: '도윤' }, requestedAt: '2026-11-24T03:00:00.000Z', dueAt: '2026-11-26T03:00:00.000Z' }), /^도윤 · 2026\.11\.24\. 12:00 KST · 기한 2026\.11\.26\. 12:00 KST$/);
});

test('CON-APR ⑥ 카드는 실제 승인 경로로만 나가고 SCR-046 화면에 붙는다', () => {
  const card = readFileSync(new URL('../ui/ContractApprovalCard.tsx', import.meta.url), 'utf8');
  for (const name of ['listOpsApprovalRequests', 'createOpsApprovalRequestApproval', 'createOpsApprovalRequestRejection', 'x-reauth-token', 'ReauthDialog']) {
    assert.ok(card.includes(name), `${name} 배선이 없다`);
  }
  assert.match(card, /kind: \['CONTRACT_TERMS_CHANGE'\]/);
  assert.match(card, /status: \['PENDING_APPROVAL'\]/);
  assert.ok(card.includes('요청한 분은 승인할 수 없습니다'));
  assert.ok(card.includes('승인 뒤 판매 승인을 받는 공연부터'));
  const page = readFileSync(new URL('../ui/Page.tsx', import.meta.url), 'utf8');
  assert.match(page, /<ContractApprovalCard \/>/);
});
