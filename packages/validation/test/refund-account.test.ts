// P-T74 환불 계좌 모양 공용 함수(BAT-420-rest 리뷰 반영 RV-04, 시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/payment.md §6 '구현에서 정한 것' ②⑦(한 규칙: bankCode 숫자 두 자리, accountNumber 숫자와 하이픈 1~30자이고 하이픈을 뺀 숫자 1~20자, holderName 1~60자),
// §11 P-T74 ①②. 표는 test/fixtures/refund-account-cases.json이고 purchase-svc(본문 검사 400 invalid-body)·payment-svc(refundAccountOf)도 같은 표를 돈다.
// 구현이 맞출 이름(계획 '리뷰 반영 계획' §3 I4): src/refund-account/index.ts의 refundAccountShape(v): { ok: true; value } | { ok: false }, 하위 경로 @peaket/validation/refund-account.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REFUND_BANKS, REFUND_BANK_CODES, refundAccountShape } from '../src/refund-account/index';

interface Row {
  name: string;
  input: { bankCode: string; accountNumber: string; holderName: string };
  ok: boolean;
  value?: { bankCode: string; accountNumber: string; holderName: string };
}
const TABLE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/refund-account-cases.json', import.meta.url)), 'utf8')) as { cases: Row[] };

describe('P-T74 환불 계좌 모양 한 규칙', () => {
  it('P-T74 ① 표의 틀린 모양은 모두 ok: false, 경계 대조(숫자 20자·하이픈 섞인 30자·예금주 60자)는 ok: true이고 값은 하이픈을 뺀 계좌번호다', () => {
    expect(TABLE.cases.filter((c) => !c.ok)).toHaveLength(8);
    for (const c of TABLE.cases) {
      const r = refundAccountShape(c.input);
      if (c.ok) expect(r, c.name).toEqual({ ok: true, value: c.value });
      else expect(r, c.name).toEqual({ ok: false });
    }
  });

  it('P-T74 ① 객체가 아니거나 칸이 글이 아니면 ok: false이고 던지지 않는다', () => {
    for (const v of [undefined, null, 'x', 1, {}, { bankCode: 88, accountNumber: '110987654321', holderName: '김환불' }, { bankCode: '88', accountNumber: 110987654321, holderName: '김환불' }]) {
      expect(refundAccountShape(v as never), JSON.stringify(v)).toEqual({ ok: false });
    }
  });
});

describe('REFUND_BANKS 화면·검사 공용 목록(BAT-421)', () => {
  it('REFUND_BANKS_26개와_검사_목록이_같다', () => {
    // 토스페이먼츠 두 자리 은행 코드 26개(payment §6 '구현에서 정한 것' ②, BAT-421)
    expect(REFUND_BANKS).toHaveLength(26);
    const codes = REFUND_BANKS.map((b) => b.code);
    // 코드는 두 자리·중복 없음·오름차순이고 화면은 이 순서대로 보인다
    for (const code of codes) expect(code).toMatch(/^[0-9]{2}$/);
    expect(new Set(codes).size).toBe(26);
    expect(codes).toEqual([...codes].sort());
    // 검사용 집합과 화면 목록이 같은 표다
    expect([...REFUND_BANK_CODES].sort()).toEqual([...codes].sort());
    // 한국어 이름은 빈 값이 아니고 HTML을 담지 않는다
    for (const bank of REFUND_BANKS) {
      expect(bank.label.trim().length).toBeGreaterThan(0);
      expect(bank.label).not.toMatch(/[<>]/);
    }
    // 목록의 모든 코드는 검사를 지나고, 목록 밖 두 자리(99·04)는 거부한다
    for (const bank of REFUND_BANKS) {
      expect(refundAccountShape({ bankCode: bank.code, accountNumber: '110-123-456789', holderName: '김환불' })).toEqual({
        ok: true,
        value: { bankCode: bank.code, accountNumber: '110123456789', holderName: '김환불' },
      });
    }
    expect(REFUND_BANK_CODES.has('99')).toBe(false);
    expect(REFUND_BANK_CODES.has('04')).toBe(false);
    expect(refundAccountShape({ bankCode: '99', accountNumber: '110123456789', holderName: '김환불' })).toEqual({ ok: false });
  });
});
