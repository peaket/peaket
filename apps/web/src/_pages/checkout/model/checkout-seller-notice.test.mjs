// F-07-9 R-T15 결제 직전 화면의 판매자 이름·중개자 고지·글씨 규칙(I-05, AC-07). 소비자 웹 코드는
// 고치지 않고 기존 구현을 시험으로 고정한다. 정본은 transfer-refund §11 R-T15·§2.2, POL-037이다.
// TR-05: 시험 안 상수 비교를 없애고 kit.css의 .t-md 정의와 화면의 판매자 항목 글씨를 읽어 비교한다.
// 빈 상호도 본다(파트너 performanceSellerNotice와 같은 경계).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { brokerNotice } = await import('../model/view.ts');
const source = readFileSync(new URL('../ui/CheckoutForm.tsx', import.meta.url), 'utf8');
const kit = readFileSync(new URL('../../../../../../packages/ds/src/styles/kit.css', import.meta.url), 'utf8');

const PERFORMANCE = 'PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다';

test('R-T15 결제 직전 고지는 판매자 이름과 POL-037 문장을 함께 보인다 [ASVS v5.0.0-1.2.1]', () => {
  assert.equal(brokerNotice('(주)피켓공연'), `판매자: (주)피켓공연. ${PERFORMANCE}`);
  assert.match(source, /\{brokerNotice\(sellerName\)\}/);
});

test('R-T15 빈 상호는 "판매자: ."를 만들지 않고 고지 문장만 보인다', () => {
  assert.equal(brokerNotice(''), PERFORMANCE);
  assert.equal(brokerNotice('   '), PERFORMANCE);
});

test('R-T15 판매자 신원정보 7항목이 결제 직전 본문에 모두 있다', () => {
  for (const label of ['상호', '대표자', '주소', '전화', '전자우편', '사업자등록번호', '통신판매업 신고번호']) assert.ok(source.includes(label), label);
});

test('R-T15 고지 글씨(t-md)는 판매자 항목 글씨보다 작지 않다', () => {
  const noticePx = /\.t-md\s*\{\s*font-size:\s*(\d+)px/.exec(kit);
  const fieldPx = /fontSize:\s*(\d+)/.exec(source);
  assert.ok(noticePx, '.t-md font-size를 kit.css에서 찾지 못했다');
  assert.ok(fieldPx, '판매자 항목 font-size를 CheckoutForm에서 찾지 못했다');
  assert.ok(Number(noticePx[1]) >= Number(fieldPx[1]), `고지 ${noticePx[1]}px < 항목 ${fieldPx[1]}px`);
  assert.match(source, /banner-body t-md[\s\S]{0,160}brokerNotice\(sellerName\)/);
});

test('R-T15 판매자 이름·고지는 글자 노드로만 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});
