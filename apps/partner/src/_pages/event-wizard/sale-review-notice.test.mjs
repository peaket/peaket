// F-07-9 SCR-021 5단계 실제 판매 승인(I-04, AC-06). 판매자가 7항목을 고치는 자리 위에서
// 팬에게 나갈 중개자 고지를 현재 상호로 렌더하는지 본다. TR-07: 호출 문자열만이 아니라
// JSX 식과 7항목 카드와의 자리를 함께 본다. 기준 트리에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./ui/LiveSaleReview.tsx', import.meta.url), 'utf8');

test('AC-06 판매자 7항목 라벨이 모두 있다', () => {
  for (const label of ['상호', '대표자', '주소', '전화', '전자우편', '사업자등록번호', '통신판매업 신고']) assert.ok(source.includes(label), label);
});

test('AC-06 고지 함수 결과를 JSX로 렌더하고, 7항목 카드 바로 위에 둔다', () => {
  assert.match(source, /import \{[^}]*performanceSellerNotice[^}]*\} from '@\/shared\/lib\/seller-notice'/);
  const notice = source.indexOf('{performanceSellerNotice(form.seller.legalName)}');
  const sellerCard = source.indexOf('aria-labelledby="sr-seller"');
  assert.ok(notice > -1, '고지 JSX 식이 없다');
  assert.ok(sellerCard > -1, '판매자 7항목 카드가 없다');
  assert.ok(notice < sellerCard && sellerCard - notice < 900, '고지가 판매자 7항목 카드 바로 위에 있지 않다');
  assert.doesNotMatch(source, /PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다/);
});

test('AC-08 판매자 상호·고지는 글자 노드로만 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});
