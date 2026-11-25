// F-07-9 SCR-021 5단계 실제 판매 승인(I-04, AC-06). 판매자가 7항목을 고치는 자리에서
// 팬에게 나갈 중개자 고지를 현재 상호로 보는지 소스로 본다. 기준 트리에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./ui/LiveSaleReview.tsx', import.meta.url), 'utf8');

test('AC-06 판매자 7항목 라벨이 모두 있고, 상호를 고치는 자리에서 고지가 같은 상태를 쓴다', () => {
  for (const label of ['상호', '대표자', '주소', '전화', '전자우편', '사업자등록번호', '통신판매업 신고']) assert.ok(source.includes(label), label);
  assert.match(source, /performanceSellerNotice\(form\.seller\.legalName\)/);
  assert.match(source, /seller\.legalName/);
});

test('AC-08 판매자 상호·고지는 글자 노드로만 그린다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-3.2.2]', () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});
