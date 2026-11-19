// P-T74 ② payment-svc의 계좌 모양 판정이 공용 표와 같다(BAT-420-rest 리뷰 반영 RV-04, 시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/payment.md §6 '구현에서 정한 것' ⑦(payment-svc도 같은 공용 함수로 다시 본다, 겹친 가드), §11 P-T74 ②.
// 표는 packages/validation/test/fixtures/refund-account-cases.json(공용 함수·purchase-svc 본문 검사와 같은 표). 맞으면 하이픈을 뺀 값, 틀리면 계좌 없음(undefined)이다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { refundAccountOf } from '../src/modules/payment/domain/payment-gateway.js';

interface Row {
  name: string;
  input: { bankCode: string; accountNumber: string; holderName: string };
  ok: boolean;
  value?: { bankCode: string; accountNumber: string; holderName: string };
}
const TABLE = JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/validation/test/fixtures/refund-account-cases.json', import.meta.url)), 'utf8')) as { cases: Row[] };

describe('P-T74 ② payment-svc 계좌 모양 판정', () => {
  test('P-T74 ② 공용 표의 경우마다 refundAccountOf가 같은 판정이다(틀리면 undefined, 맞으면 하이픈을 뺀 값)', () => {
    expect(TABLE.cases.length).toBeGreaterThanOrEqual(12);
    for (const c of TABLE.cases) expect(refundAccountOf(c.input), c.name).toEqual(c.ok ? c.value : undefined);
  });
});
