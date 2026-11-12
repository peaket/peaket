// SCR-024 규칙 폼 ↔ AST 시험(ADR-0261 결정 3·13). 서버 저장 검사는 core-svc sale-policy 시험이 본다.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { DEFAULT_FORM, formOf, kindOf, ruleFromForm, summaryOf } = await import('./form.ts');
const { parseSalePolicy } = await import('@peaket/validation/sale-policy');

test('선예매 폼은 명단·기간·1인 한도·거부를 규칙으로 만들고 되돌린다', () => {
  const r = ruleFromForm({ ...DEFAULT_FORM, name: '팬클럽', from: '2026-11-20T20:00', to: '2026-11-20T22:00', listKey: 'fanclub', limit: 2 });
  assert.deepEqual(r, {
    version: 1,
    name: '팬클럽',
    rounds: 'ALL',
    during: { from: '2026-11-20T20:00:00+09:00', to: '2026-11-20T22:00:00+09:00' },
    rule: { if: { fact: 'buyer.lists', has: 'fanclub' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
  });
  assert.equal(kindOf(r), 'presale');
  assert.equal(summaryOf(r), '1인 2매');
  assert.deepEqual(formOf(r), { ...DEFAULT_FORM, name: '팬클럽', from: '2026-11-20T20:00', to: '2026-11-20T22:00', listKey: 'fanclub', limit: 2 });
});

test('등급 판매 여부와 취소 공제율 폼도 같은 꼴로 오간다', () => {
  const grade = ruleFromForm({ ...DEFAULT_FORM, kind: 'grade', name: 'VIP 제외', grade: 'VIP' });
  assert.equal(kindOf(grade), 'grade');
  assert.equal(summaryOf(grade), '거부(GRADE_NOT_ON_SALE)');
  assert.equal(formOf(grade).grade, 'VIP');
  const refund = ruleFromForm({ ...DEFAULT_FORM, kind: 'refund', name: '7~9일', daysFrom: 7, daysTo: 9, rate: 10 });
  assert.equal(kindOf(refund), 'refund');
  assert.equal(summaryOf(refund), '7~9일 전 10%');
  assert.equal(formOf(refund).rate, 10);
  // 기간이 비면 during을 싣지 않는다
  assert.equal('during' in ruleFromForm(DEFAULT_FORM), false);
});

test('폼이 만든 규칙은 서버와 같은 parseSalePolicy를 지난다', () => {
  const ctx = { rounds: [], grades: ['R', 'S', 'A'] };
  const forms = [
    { ...DEFAULT_FORM, listKey: 'fanclub' },
    { ...DEFAULT_FORM, kind: 'grade', name: 'R 제외', grade: 'R' },
    { ...DEFAULT_FORM, kind: 'refund', name: '7~9일', daysFrom: 7, daysTo: 9, rate: 10 },
  ];
  for (const form of forms) {
    const parsed = parseSalePolicy([ruleFromForm(form)], ctx);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  }
});
