// J-T32 SCR-049 정산 지급 연결 화면(BAT-630 LCH-110, d5 §7.10, settlement §9, ASVS 8.2.1·8.2.2).
// 실제 API 함수·역할·재인증·승인 기한·보류 사유·계좌 끝 4자리·KYC 예고를 소스로 확인한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('./ConnectedPage.tsx');
const model = read('../model/settlement-payout.ts');
const routePage = read('./Page.tsx');

test('J-T32 ① 지급일 탭은 실제 묶음 목록·정산서·미수금 API를 부르고 승인 기한을 보인다', () => {
  for (const name of ['listOpsPayoutBatches', 'getOpsPayoutBatch', 'listOpsSettlements', 'listOpsReceivables', 'listOpsApprovalRequests']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.match(page, /ensureConsoleApi\(/);
  assert.match(page, /payoutDate/);
  assert.match(page, /approvalDueAt|승인 기한/);
  assert.match(page, /statementCount|건수/);
  assert.match(page, /totalAmount|합계/);
});

test('J-T32 ② 상세는 정산서·지급 건·보류 사유·계좌 끝 4자리·KYC 예고를 보인다', () => {
  assert.match(page, /getOpsPayoutBatch\(/);
  assert.match(page, /statements/);
  assert.match(page, /payouts/);
  assert.match(page, /holds/);
  assert.match(page, /holdReason/);
  assert.match(page, /payoutAccountLast4/);
  assert.match(page, /kycNotice|KYC 예고/);
  assert.match(page, /balanceConfirmed|잔액 확인/);
  assert.match(page, /role="button"[\s\S]{0,200}tabIndex=\{0\}/);
  assert.match(page, /onKeyDown/);
});

test('J-T32 ③ viewer는 읽기, operator는 확인 요청·실행 기록, commander는 재인증 뒤 승인·반려, CS는 차단한다', () => {
  assert.match(page, /canApprove\(/);
  assert.match(page, /canRequest\(/);
  assert.match(page, /canRecordExecution\(/);
  assert.match(page, /ReauthDialog/);
  assert.match(page, /createOpsApprovalRequestApproval/);
  assert.match(page, /createOpsApprovalRequestRejection/);
  assert.match(page, /createOpsPayoutBatch\(/);
  assert.match(page, /createOpsPayoutBatchPortoneExecution\(/);
  assert.match(model, /role === 'operator' \|\| role === 'commander'/);
  assert.match(model, /export function canApprove[\s\S]{0,80}role === 'commander'/);
  assert.match(model, /cs_agent/);
  assert.match(model, /cs_lead/);
  assert.match(page, /403|권한 없음|CS 담당자|NoAccess/);
});

test('J-T32 ④ 디자인 보드는 ?state= 미리보기에만 남기고 실제 경로는 연결 화면을 쓴다', () => {
  assert.match(routePage, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(routePage, /function BoardPage/);
});
