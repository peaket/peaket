// 생성 타입을 실제로 쓸 수 있는지 본다(타입 검사가 이 파일을 본다). 닫힌 스키마(additionalProperties: false)의 입력 타입에
// 정상 값을 넣을 수 있어야 하고, 실행 때는 정의 밖 칸을 거절해야 한다(design.md 결정 9, ASVS 8.2.3).
import { expect, test } from 'vitest';
import { BehaviorSummary, type BehaviorSummary as BehaviorSummaryInput, PaymentAcceptToss, type PaymentAcceptToss as TossInput } from '@peaket/contracts/openapi/model';

test('ASVS8_2_3_닫힌스키마의입력타입에_정상값을넣을수있고_정의밖칸은실행때거절한다', () => {
  const summary: BehaviorSummaryInput = { v: 1, windowMs: 60000, pointerMoves: 3 };
  const toss: TossInput = { pg: 'TOSS', paymentKey: 'k', amount: 55000 };
  expect(BehaviorSummary.parse(summary)).toEqual(summary);
  expect(PaymentAcceptToss.parse(toss)).toEqual(toss);
  expect(PaymentAcceptToss.safeParse({ ...toss, orderStatus: 'CONFIRMED' }).success).toBe(false);
});
