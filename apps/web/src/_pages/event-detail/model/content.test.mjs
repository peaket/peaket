// SCR-002 공연 상세 '예매 안내사항'의 '부정 예매 조사' 항목 시험(FRN-090 새 맥락 리뷰 결함 1, d5 §5.2 ⑯, POL-046 사전 고지, ADR-0173).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/web test`). 타입 지우기로 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as content from './content.ts';

test('POL046_ADR0173_예매 안내사항에 부정 예매 조사 항목이 있고 제목은 d5 그대로다', () => {
  assert.equal(content.FRAUD_INVESTIGATION_NOTICE?.title, '부정 예매 조사');
});

test('POL046_ADR0173_부정 예매 조사 항목은 d5가 적은 고지 여섯 가지를 모두 담는다', () => {
  const body = content.FRAUD_INVESTIGATION_NOTICE.body;
  // ① 부정 예매로 보는 다섯 경우(POL-046 ①)
  for (const s of ['매크로', '대기열 우회', '보안문자 우회', '명의 대여', '매수 제한 회피']) assert.ok(body.includes(s), s);
  // ② 가족·지인 대리 예매는 아님
  assert.ok(body.includes('돈이 오가지 않은 가족·지인 대리 예매는 부정 예매가 아닙니다'));
  // ③ 양도만 잠기고 입장·직접 취소는 됨, 풀리는 일곱 때, 늦어도 14일 뒤(늘리지 않음)
  assert.ok(body.includes('입장과 직접 취소(취소 수수료 기준대로)는 그대로 할 수 있습니다'));
  for (const s of ['소명이 인정되면', '혐의 없이 조사가 끝나면', '조치가 끝난 뒤 남은 표', '조사 대상에서 빠지면', '입장이 시작되면', '조치 요청이 반려되거나 만료되면', '늦어도 14일 뒤']) {
    assert.ok(body.includes(s), s);
  }
  assert.ok(body.includes('늘리지 않습니다'));
  // ④ 사람이 소명을 보고 두 사람이 정함, ⑤ 공제 없는 전액 환급
  assert.ok(body.includes('두 사람이 정합니다'));
  assert.ok(body.includes('공제 없이 전액 환급'));
  // ⑥ 받은 표도 취소될 수 있고 환급은 결제자에게
  assert.ok(body.includes('양도로 받은 표도') && body.includes('환급은 결제한 분에게 갑니다'));
});

// FRN-090 재리뷰 결함 A: 조사는 판매가 다 끝난 뒤가 아니라 온세일 윈도우가 끝난 뒤(T+60분) 시작해 판매 종료까지 이어진다(POL-046 ②)
test('POL046_조사 시점은 온세일이 끝난 뒤이고 판매가 끝난 뒤라고 쓰지 않는다', () => {
  const body = content.FRAUD_INVESTIGATION_NOTICE.body;
  assert.ok(!body.includes('판매가 끝난 뒤'), '판매가 끝난 뒤');
  assert.ok(body.includes('온세일(오픈 판매)이 끝난 뒤'));
  // 재리뷰 결함 C: 판매 종료에서 멈추는 것은 후보 찾기뿐이고 조사·소명·잠금은 그 뒤에도 이어진다(forensic-replay §6.7, POL-046 ①)
  assert.ok(!body.includes('판매 종료까지 이어지는'), '판매 종료까지 이어지는');
});
