// SCR-046 승인 업무 화면의 배선 시험(F-06-3 GAT-290·GAT-300, 시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §7.2, docs/features/settlement.md §9(정산 조정 카드), d5 §7.7,
// docs/frontend.md §2.2(생성 호출만), docs/security/asvs/transfer-refund.md(글자 노드·저장소 0).
// 서버와 실제로 주고받는 흐름은 구현 뒤 ops-svc 화면 연결 시험이 본다. 이 파일은 화면 소스가 그 호출만 쓰는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const connected = read('./ConnectedPage.tsx');
const cards = read('./cards.tsx');
const model = read('../model/live.ts');
const router = read('../../../app/router.tsx');
const ops = read('../../../../../../packages/api-client/src/gen/endpoints/ops/ops.ts');
const operations = read('../../../../../../packages/api-client/src/gen/operations.ts');
const count = (src, re) => (src.match(re) ?? []).length;

test('화면은 생성 호출 다섯과 세션 읽기만 쓰고 fetch를 만들지 않는다', () => {
  const used = [...connected.matchAll(/const \{ (\w+) \} = await ops\(\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, ['createOpsApprovalRequestApproval', 'createOpsApprovalRequestRejection', 'createOpsApprovalRequestWithdrawal', 'getMyOpsAuthSession', 'getOpsApprovalRequest', 'listOpsApprovalRequests']);
  assert.match(connected, /const ops = \(\) => import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.doesNotMatch(connected, /\bfetch\s*\(/);
  assert.doesNotMatch(connected, /XMLHttpRequest|EventSource|WebSocket/);
  assert.match(connected, /ensureConsoleApi\(\)/);
  for (const name of ['createOpsApprovalRequestApproval', 'createOpsApprovalRequestRejection', 'createOpsApprovalRequestWithdrawal']) {
    assert.match(ops, new RegExp(`export const ${name} = async`));
  }
  assert.match(operations, /createOpsApprovalRequestApproval: \{[^}]*method: "POST",path: "\/v1\/ops\/approval-requests\/\{approvalId\}\/approvals"/);
});

test('승인·반려·철회는 한 곳에서만 보내고 처리 중에는 다시 보내지 않으며 판을 If-Match로 싣는다', () => {
  assert.equal(count(connected, /createOpsApprovalRequestApproval\(/g), 1);
  assert.equal(count(connected, /createOpsApprovalRequestRejection\(/g), 1);
  assert.equal(count(connected, /createOpsApprovalRequestWithdrawal\(/g), 1);
  assert.match(connected, /if \(busy\) return/);
  assert.match(connected, /setBusy\(true\)/);
  assert.match(connected, /finally \{\s*setBusy\(false\)/);
  assert.match(connected, /headers: \{ 'If-Match': ifMatchOf\(version\) \}/);
  assert.ok(count(connected, /'If-Match': ifMatchOf\(/g) >= 1);
});

test('1·2인 배지와 증빙 확인 사실을 싣고 종류별 카드를 그린다', () => {
  assert.match(connected, /quorumLabel\(/);
  assert.match(connected, /evidenceOf\(/);
  assert.match(cards, /SYSTEM_FAULT_REFUND/);
  assert.match(cards, /MINOR_CONTRACT_CANCEL/);
  assert.match(cards, /TRANSFER_RECLAIM/);
});

test('승인은 재인증 토큰을 머리로 보내고 요청자에게는 버튼을 숨긴다', () => {
  assert.match(connected, /'X-Reauth-Token': token/);
  assert.match(connected, /canAct\(/);
  assert.match(connected, /if \(!a\.approve\) return/);
  assert.match(connected, /if \(!a\.reject\) return/);
  assert.match(connected, /if \(!a\.withdraw\) return/);
});

test('정산 조정 카드는 금액·사유·정산서 ID만 보이고 결제사·계좌는 보이지 않는다', () => {
  const card = cards.slice(cards.indexOf('SETTLEMENT_ADJUSTMENT'));
  assert.ok(card.length > 0);
  assert.match(card, /targetRef/);
  assert.match(card, /amount/);
  assert.match(card, /reasonText/);
  assert.doesNotMatch(cards, /pgStore|pgName|bankAccount|accountNumber|payerName|phone/);
});

test('지급 카드는 payeeDigest가 있으면 64자만 보이고 아니면 지문 없음으로 둔다', () => {
  assert.match(cards, /payeeDigestOf\(/);
  assert.match(cards, /digestMatches\(/);
  assert.match(cards, /'지급 대상이 바뀌었습니다/);
});

test('서버 글은 글자 노드로만 그리고 브라우저 저장소에 승인 값을 남기지 않는다', () => {
  assert.doesNotMatch(connected, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(cards, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(connected, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(model, /localStorage|sessionStorage|indexedDB/);
});

test('상세 경로가 라우터에 있다', () => {
  assert.match(router, /cs\/approvals\/:approvalId/);
});
