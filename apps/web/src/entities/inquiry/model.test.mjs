// SCR-056 문의 유형 시험(apply-legal-review-to-screens tasks 2.2, FR-069, ADR-0173 결정 9).
// 기준: d5 §5.30 문의하기 그림(12개와 '외부 되팔이 게시물 신고' 안내), openapi `InquiryCategory`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INQUIRY_TYPES, INQUIRY_CATEGORY_OF, RESALE_POST_NOTICE, inquiryTypeNotice } from './model.ts';

const OPENAPI = readFileSync(new URL('../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
const OPENAPI_CATEGORIES = (() => {
  const m = OPENAPI.match(/\bInquiryCategory: \{ type: string, enum: \[([^\]]+)\]/);
  assert.ok(m, 'openapi에 InquiryCategory 열거값이 없다');
  return m[1].split(',').map((x) => x.trim());
})();

test('FR069_문의 유형은 d5 §5.30 순서의 12개다', () => {
  assert.deepEqual([...INQUIRY_TYPES], [
    '예매·결제',
    '취소·환불(사정이 있어 공제 면제를 요청)',
    '양도',
    '입장·현장',
    '계정',
    '자동화된 결정(추가 검증) 설명·재검토',
    '공연(판매자) 관련 분쟁',
    '미성년자 계약 취소',
    '굿즈·상품',
    '게시물 조치 이의',
    '외부 되팔이 게시물 신고',
    '기타',
  ]);
});

test('FR069_유형마다 openapi InquiryCategory 값이 하나씩, 빠짐없이 맞는다', () => {
  const codes = INQUIRY_TYPES.map((t) => INQUIRY_CATEGORY_OF[t]);
  assert.deepEqual([...codes].sort(), [...OPENAPI_CATEGORIES].sort());
  assert.equal(INQUIRY_CATEGORY_OF['외부 되팔이 게시물 신고'], 'RESALE_POST_REPORT');
});

test('ADR0173결정9_외부 되팔이 게시물 신고를 고르면 d5 안내가 보이고, 다른 유형에는 없다', () => {
  assert.equal(
    RESALE_POST_NOTICE,
    'PEAKET 밖 사이트에서 이 공연 표를 웃돈으로 파는 공개 게시물의 주소와 설명을 적어 주세요. 로그인해야 보이는 비공개 모임의 글이나 받은 메시지는 받지 않습니다. 접수만 확인해 드리고, 조사 결과는 알려 드리지 않습니다',
  );
  assert.equal(inquiryTypeNotice('외부 되팔이 게시물 신고'), RESALE_POST_NOTICE);
  for (const t of INQUIRY_TYPES) if (t !== '외부 되팔이 게시물 신고') assert.equal(inquiryTypeNotice(t), undefined, t);
  assert.equal(inquiryTypeNotice(''), undefined);
});
