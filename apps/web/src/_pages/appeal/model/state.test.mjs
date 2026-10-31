// SCR-042 상태 → 화면 조각 시험(apply-legal-review-to-screens tasks 2.1). 상태 이름은 d5 §5.24 상태 표 첫 칸 그대로다(design.md 결정 3).
// `pnpm --filter @peaket/web test`가 타입 지우기로 .ts를 그대로 읽는다(state.ts·screens.account.ts는 타입 import만 쓴다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCR042_STATES, SCR042_FRAUD_STATES, SCR042_HOLDER_STATES } from '../../../shared/config/screens.account.ts';
import { appealView } from './state.ts';

test('SCR-042 상태마다 화면 조각이 정해진다', () => {
  for (const st of SCR042_STATES) {
    const v = appealView(st);
    assert.ok(v, st);
    assert.ok(['form', 'result', 'closed', 'empty'].includes(v.mode), st);
  }
});

test('FR073_ADR0173_결제자 부정 예매 상태에 d5 §5.24의 새 상태 넷이 있다', () => {
  for (const st of ['양도 잠금 풀림 · 부정 예매', '조치 결과 · 부정 예매', '이의 결과 · 부정 예매 · 인정', '이의 결과 · 부정 예매 · 기각']) {
    assert.ok(SCR042_FRAUD_STATES.includes(st), st);
    const v = appealView(st);
    assert.equal(v.kind, 'fraud', st);
    assert.equal(v.party, 'PAYER', st);
  }
  assert.equal(appealView('양도 잠금 풀림 · 부정 예매').result, 'released');
  assert.equal(appealView('조치 결과 · 부정 예매').result, 'actioned');
  assert.equal(appealView('이의 결과 · 부정 예매 · 인정').result, 'objection-accepted');
  assert.equal(appealView('이의 결과 · 부정 예매 · 기각').result, 'objection-rejected');
});

test('POL046_ADR0173결정4_받은 사람 상태 넷은 party HOLDER이고 결제자 상태와 겹치지 않는다', () => {
  assert.deepEqual([...SCR042_HOLDER_STATES], ['받은 표 확인 요청', '제출됨 · 받은 표', '결과 · 취소 대상에서 빠짐', '결과 · 취소됨']);
  for (const st of SCR042_HOLDER_STATES) {
    assert.ok(SCR042_STATES.includes(st), st);
    assert.ok(!SCR042_FRAUD_STATES.includes(st), st);
    const v = appealView(st);
    assert.equal(v.kind, 'fraud', st);
    assert.equal(v.party, 'HOLDER', st);
  }
  assert.equal(appealView('받은 표 확인 요청').mode, 'form');
  assert.equal(appealView('제출됨 · 받은 표').formState, 'submitted');
  assert.equal(appealView('결과 · 취소 대상에서 빠짐').result, 'holder-excluded');
  assert.equal(appealView('결과 · 취소됨').result, 'holder-cancelled');
});

test('결제자 부정 예매가 아닌 상태는 party가 없다', () => {
  assert.equal(appealView('작성').party, undefined);
  assert.equal(appealView('양도 회수 사유').party, undefined);
});
