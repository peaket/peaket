// SCR-021 5단계 판매 승인 요청 화면의 배선 시험(BAT-617, LCH-080, d5 §6.4, ASVS 8.2.2·8.2.3).
// 실제 API 함수·상태 새로고침·변경 취소·권한 문구·반려 사유·이전 단계 링크를 소스로 확인한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('./LiveSaleReview.tsx');
const model = read('../model/sale-review-live.ts');
const wizard = read('./EventWizardPage.tsx');
const api = read('../../../shared/api/partner-live.ts');

test('S-T41 ⑫ 화면은 실제 판매 승인 현황·요청·변경 취소 API를 부르고 성공 뒤 다시 읽는다', () => {
  for (const name of ['getPartnerProductionSaleReview', 'createPartnerProductionSaleReview', 'deletePartnerProductionSaleReview']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /import\('@\/shared\/api'\)/);
  assert.match(page, /partnerApi\(\)\.request/);
  assert.match(page, /await load\(\)/);
  assert.match(page, /spinner|불러오는 중/);
});

test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] 파트너 실무자는 요청·변경 취소 단추가 없고 403을 권한 문구로 보인다', () => {
  assert.match(model, /partner-admin-required/);
  assert.match(model, /파트너 관리자만/);
  assert.match(page, /memberDenied/);
  assert.match(page, /memberDenied \?/);
  assert.match(page, /canRequest/);
  assert.match(page, /canCancel/);
});

test('S-T41 ⑫ 5단계는 이전 단계로 돌아가고, 반려 사유와 확인 대화상자의 되돌리기를 보인다', () => {
  assert.match(page, /routes\.eventTab\(productionId, 'edit'\)/);
  assert.match(page, /돌아가서 고치기/);
  assert.match(page, /rejectionReason/);
  assert.match(page, /반려 사유/);
  // 입력을 잃지 않고 확인 대화상자에서 되돌아간다
  assert.match(page, /setConfirmOpen\(false\)/);
  assert.match(page, /role="alertdialog"|role="dialog"|Modal/);
});

test('S-T41 ⑫_[ASVS v5.0.0-8.2.3] 계좌번호는 요청 본문에만 있고 화면 저장소·응답 표시에 남기지 않는다', () => {
  assert.equal(/localStorage\.|sessionStorage\.|window\.localStorage|window\.sessionStorage/.test(page), false, '브라우저 저장소를 쓴다');
  assert.equal(/localStorage\.|sessionStorage\./.test(model), false, '모델이 브라우저 저장소를 쓴다');
  // 현황 응답에서 계좌를 채우지 않는다
  assert.match(model, /payout: \{ bankCode: '', accountNumber: '', holderName: '' \}/);
  // 계좌는 저장하지 않는다는 안내가 보인다
  assert.match(page, /저장하지 않습니다/);
  assert.match(page, /지급대행 연동 전/);
});

test('S-T41 ⑫ 실제 공연만 연결 화면을 쓰고 목업 공연은 지금 보드를 남긴다', () => {
  assert.match(wizard, /getProduction\(eventId\)/);
  assert.match(wizard, /<LiveSaleReview productionId=\{eventId\}/);
  assert.match(wizard, /mode === 'sale-review'/);
});
