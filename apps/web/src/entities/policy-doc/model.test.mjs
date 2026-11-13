// LCH-180·LCH-185 약관·처리방침 본문 검사(docs/security/data-classification.md, POL-027, POL-046).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POLICY_DOCS, getPolicyDoc } from './model.ts';

const doc = (slug) => POLICY_DOCS.find((d) => d.slug === slug);
const text = (d) => JSON.stringify(d);

test('LCH-180 처리방침은 목적·파기·위탁·권리·자동화 결정·쿠키·책임자·국외 이전·가명정보·부정 예매 조사를 담는다', () => {
  const p = doc('privacy');
  assert.ok(p);
  assert.deepEqual(p.sections.map((s) => s.id), ['pp-1', 'pp-2', 'pp-3', 'pp-4', 'pp-5', 'pp-6', 'pp-7', 'pp-8', 'pp-9', 'pp-10']);
  for (const phrase of ['처리 목적', '파기', '위탁', '정보주체의 권리', '자동화된 결정', '쿠키', '개인정보 보호책임자', '국외 이전', '가명정보', '부정 예매 조사']) {
    assert.ok(text(p).includes(phrase), phrase);
  }
  assert.ok(text(p).includes('__Host-peaket_fv'));
  assert.ok(text(p).includes('일본(도쿄)'));
  assert.ok(text(p).includes('전액 환급') === false, '처리방침에는 약관 환급 문구를 넣지 않는다');
});

test('LCH-185 약관은 정렬·취소 공제·양도·금지행위·중개자 고지·분쟁·부정 예매 취소를 담는다', () => {
  const t = doc('terms');
  assert.ok(t);
  for (const phrase of ['정렬 방식', '1인 1순번', '매수 한도', '취소 시점별 공제율', '양도', '금지행위', '통신판매중개자', '분쟁 해결', '부정 예매 취소', '전액 환급', '14일']) {
    assert.ok(text(t).includes(phrase), phrase);
  }
  assert.ok(t.sections.some((s) => s.id === 'tm-10'));
});

test('LCH-185 분쟁·판매 조건·게시물 운영정책의 빈 자리를 채웠다', () => {
  for (const slug of ['dispute', 'sale-terms', 'community']) {
    const d = doc(slug);
    assert.ok(d, slug);
    assert.ok(!text(d).includes('"kind":"placeholder"'), slug);
  }
  assert.ok(text(doc('dispute')).includes('3영업일'));
  assert.ok(text(doc('sale-terms')).includes('1인 1순번'));
  assert.ok(text(doc('community')).includes('권리 침해'));
});

test('LCH-180·LCH-185 필수 문서는 본문이 비어 있지 않고 주소로 찾을 수 있다', () => {
  for (const slug of ['terms', 'privacy', 'dispute', 'sale-terms', 'community', 'business']) {
    const d = getPolicyDoc(slug);
    assert.ok(d && d.sections.length > 0, slug);
    assert.ok(d.effective.length > 0, slug);
  }
  assert.equal(getPolicyDoc('nope'), undefined);
});

test('LCH-180·LCH-185 문서 절 목록이 정본 순서와 같다', () => {
  const ids = (slug) => doc(slug).sections.map((s) => s.id);
  assert.deepEqual(ids('terms'), Array.from({ length: 10 }, (_, i) => `tm-${i + 1}`));
  assert.deepEqual(ids('dispute'), Array.from({ length: 5 }, (_, i) => `ds-${i + 1}`));
  assert.deepEqual(ids('sale-terms'), Array.from({ length: 4 }, (_, i) => `st-${i + 1}`));
  assert.deepEqual(ids('community'), Array.from({ length: 4 }, (_, i) => `cp-${i + 1}`));
});

test('LCH-180·LCH-185 정책 문서 링크는 같은 출처 경로이고 정책 링크는 실제 문서를 가리킨다', () => {
  const slugs = new Set(POLICY_DOCS.map((d) => d.slug));
  for (const d of POLICY_DOCS) {
    for (const block of d.sections.flatMap((s) => s.blocks)) {
      if (block.kind !== 'link') continue;
      assert.ok(block.href.startsWith('/') && !block.href.startsWith('//'), `${d.slug}: ${block.href}`);
      const policy = block.href.match(/^\/policy\/([^/?#]+)/);
      if (policy) assert.ok(slugs.has(policy[1]), `${d.slug}: ${block.href}`);
    }
  }
});
