// F-07-9 SCR-020 판매자 정보(I-04, AC-05·AC-06·AC-08). 화면 소스를 읽어 7항목·중개자 고지·
// 정산 주체 표·계좌 가림·역할 차이가 실제로 그려지는지 본다. TR-06·TR-07: 태그가 요구를 보도록
// 계좌 가림은 payout-live의 뷰 함수와 PayoutLive 렌더로, 비회원은 실제 분기와 문구로,
// 복사 문장은 EventOverviewPage·StepSeller의 렌더 식으로 본다. 기준 트리에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./ui/SellerPage.tsx', import.meta.url), 'utf8');

test('AC-05 판매자 정보는 7항목을 SELLER_FIELDS 순서로 그리고 중개자 고지 원문을 법정 고지 배너에 그린다', () => {
  assert.match(source, /SELLER_FIELDS\.map/);
  assert.match(source, /performanceSellerNotice\(seller\.companyName\)/);
  assert.match(source, /법정 고지/);
  const notice = source.indexOf('performanceSellerNotice(seller.companyName)');
  const banner = source.lastIndexOf('banner banner-legal', notice);
  assert.ok(banner > -1 && notice - banner < 400, '고지가 법정 고지 배너 안에 있지 않다');
});

test('AC-05 정산 주체 표는 판매자·예금주·중개수수료율을 한 곳에서 가져와 행으로 그린다', () => {
  assert.match(source, /settlementDisclosure\(\{/);
  assert.match(source, /sellerName:\s*seller\.companyName/);
  assert.match(source, /payoutHolder:\s*stellaOrg\.payout\.holder/);
  assert.match(source, /commissionRate:\s*stellaOrg\.commissionRate/);
  assert.match(source, /중개자 지위와 정산/);
  assert.match(source, /rows\.map\(/);
  assert.match(source, /row\.label/);
  assert.match(source, /row\.value/);
  assert.match(source, /routes\.settingsPayout\(\)/);
});

test('AC-05 계좌는 예금주만 쓰고 전체 번호를 싣지 않는다 [ASVS v5.0.0-14.2.6]', () => {
  assert.doesNotMatch(source, /accountMasked/);
  assert.doesNotMatch(source, /accountNumber/);
  assert.match(source, /payout\.holder/);
});

test('AC-05 정산 계좌 화면은 은행 이름과 끝 4자리만 그린다 [ASVS v5.0.0-14.2.6]', () => {
  const payout = readFileSync(new URL('./ui/live/PayoutLive.tsx', import.meta.url), 'utf8');
  const view = readFileSync(new URL('./model/payout-live.ts', import.meta.url), 'utf8');
  assert.match(view, /payoutAccountLast4/);
  assert.match(view, /masked:[\s\S]{0,40}\*\*\*\*\$\{last4\}/);
  assert.match(payout, /\{view\.bankName\}/);
  assert.match(payout, /\{view\.last4\}/);
  assert.doesNotMatch(payout, /view\.masked/);
  assert.match(payout, /\(끝 4자리\)/);
});

test('AC-08 판매자 이름·고지는 글자 노드로만 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test('AC-05 실무자는 변경 요청을 할 수 없고 그 이유가 모바일·데스크톱에 모두 보인다 [ASVS v5.0.0-8.2.3]', () => {
  assert.match(source, /pv\.isMember/);
  assert.match(source, /변경 요청은 파트너 관리자만 할 수 있습니다/);
  assert.match(source, /banner-warning md:hidden/);
  assert.match(source, /aria-disabled/);
});

test('AC-05 판매자 정보 API 계약은 7항목+면제 근거만 주고 정산 계좌를 싣지 않는다 [ASVS v5.0.0-8.2.3]', () => {
  const openapi = readFileSync(new URL('../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
  const profile = openapi.split('\n').find((l) => l.startsWith('    SellerProfile:'));
  const info = openapi.split('\n').find((l) => l.startsWith('    SellerInfo:'));
  assert.ok(profile && info, 'SellerProfile·SellerInfo 스키마를 찾지 못했다');
  assert.doesNotMatch(profile, /payoutAccount|accountNumber|accountMasked/);
  for (const key of ['legalName', 'representative', 'address', 'phone', 'email', 'businessRegNo', 'mailOrderReportNo', 'exemptionBasis']) assert.ok(info.includes(key), key);
});

test('AC-06·G-06 EventOverviewPage·StepSeller는 복사 문장이 아니라 공용 고지 함수를 렌더한다', () => {
  for (const rel of ['../event-overview/ui/EventOverviewPage.tsx', '../event-wizard/ui/StepSeller.tsx']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(text, /performanceSellerNotice/);
    assert.match(text, /\{performanceSellerNotice\([^)]*companyName\)\}/);
    assert.doesNotMatch(text, /PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다/);
  }
});
