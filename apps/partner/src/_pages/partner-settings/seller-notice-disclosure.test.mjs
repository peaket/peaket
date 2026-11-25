// F-07-9 SCR-020 판매자 정보(I-04, AC-05·AC-08·AC-10). 화면 소스를 읽어 7항목·중개자 고지·
// 정산 주체 표·계좌 가림·역할 차이가 실제로 그려지는지 본다. 시험은 구현 전 기준 트리에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./ui/SellerPage.tsx', import.meta.url), 'utf8');

test('AC-05 판매자 정보는 7항목을 SELLER_FIELDS 순서로 그리고 중개자 고지 원문을 보인다', () => {
  assert.match(source, /SELLER_FIELDS\.map/);
  assert.match(source, /performanceSellerNotice\(seller\.companyName\)/);
  assert.match(source, /법정 고지/);
});

test('AC-05 정산 주체 표는 판매자·예금주·중개수수료율을 한 곳에서 가져온다', () => {
  assert.match(source, /settlementDisclosure\(\{/);
  assert.match(source, /sellerName:\s*seller\.companyName/);
  assert.match(source, /payoutHolder:\s*stellaOrg\.payout\.holder/);
  assert.match(source, /commissionRate:\s*stellaOrg\.commissionRate/);
  assert.match(source, /중개자 지위와 정산/);
  assert.match(source, /routes\.settingsPayout\(\)/);
});

test('AC-05 계좌 전체 번호를 판매자 정보 화면에 싣지 않는다 [ASVS v5.0.0-14.2.6]', () => {
  assert.doesNotMatch(source, /accountMasked/);
  assert.doesNotMatch(source, /accountNumber/);
  assert.match(source, /payout\.holder/);
});

test('AC-08 판매자 이름·고지는 글자 노드로만 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test('AC-05 실무자는 변경 요청을 할 수 없고 그 이유가 보인다 [ASVS v5.0.0-8.2.3]', () => {
  assert.match(source, /pv\.isMember/);
  assert.match(source, /변경 요청은 파트너 관리자만 할 수 있습니다/);
});
