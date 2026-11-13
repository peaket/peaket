// LCH-180·LCH-185 법률 검토 목록·내부 관리계획 연결 검사.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('LCH-180·LCH-185 법률 검토 목록이 확인 30~37번과 제출 전 상태를 담는다', () => {
  const doc = read('docs/review/legal/BAT-590-legal-review.md');
  for (let n = 30; n <= 37; n += 1) assert.ok(doc.includes(`| ${n} |`), `${n}`);
  assert.ok(doc.includes('제출 전'));
  assert.ok(doc.includes('POL-027'));
  assert.ok(doc.includes('부정 예매'));
});

test('LCH-180 내부 관리계획과 처리방침 초안이 BAT-590 반영을 가리킨다', () => {
  const plan = read('docs/security/internal-management-plan.md');
  assert.ok(plan.includes('BAT-590'));
  assert.ok(plan.includes('BAT-590-legal-review.md'));
  const data = read('docs/security/data-classification.md');
  assert.ok(data.includes('반영(2026-11-13, BAT-590)'));
  assert.ok(data.includes('처리방침 pp-8~pp-10'));
});
