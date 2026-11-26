// F-06-5 SCR-056 문의 화면의 계좌번호 꼴 찾기·가림과 상세 주소 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: d5 §5.30, docs/security/data-classification.md '고객 문의', ASVS v5.0.0-1.2.2. 이 화면 부품은 이미 있으므로 기준 트리에서도 통과한다.
// 공용 부품(@peaket/validation/account-number)으로 옮긴 뒤에도 같은 동작이어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAccountNumbers, maskAccountNumbers } from './account.ts';
import { inquiryHref } from '../../../entities/inquiry/model.ts';

test('문의 내용 속 계좌번호 꼴을 찾아 (계좌번호 지움)으로 바꾼다 [ASVS v5.0.0-1.2.2]', () => {
  const text = '환불은 110-123-456789 계좌로 받고 싶습니다. 연락처는 010-9876-5432입니다.';
  assert.equal(findAccountNumbers(text).length, 1);
  assert.equal(maskAccountNumbers(text), '환불은 (계좌번호 지움) 계좌로 받고 싶습니다. 연락처는 010-9876-5432입니다.');
  assert.equal(maskAccountNumbers('계좌번호가 없는 본문입니다.'), '계좌번호가 없는 본문입니다.');
});

test('문의 상세 주소는 문의 ID만 encode하고 본문·계좌번호를 넣지 않는다 [ASVS v5.0.0-1.2.2]', () => {
  assert.equal(inquiryHref('inq-0001'), '/help/inquiries/inq-0001');
  assert.equal(inquiryHref('a/b?c'), '/help/inquiries/a%2Fb%3Fc');
  assert.ok(!inquiryHref('inq-0001').includes('110-123'));
});
