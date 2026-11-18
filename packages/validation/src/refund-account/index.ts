// 환불·배상 계좌 모양 한 규칙(docs/features/payment.md §6 '구현에서 정한 것' ②⑦, §11 P-T74, BAT-420-rest 리뷰 반영 RV-04).
// bankCode는 토스 은행 코드 표의 숫자 두 자리, accountNumber는 숫자와 하이픈 1~30자이고 하이픈을 뺀 숫자 1~20자, holderName은 1~60자(앞뒤 공백을 뺀 길이, 제어 문자 없음)다.
// purchase-svc 본문 검사(틀리면 400 invalid-body)가 쓰고, openapi RefundAccount의 pattern·길이와 같은 규칙이다. 던지지 않고 값을 글에 싣지 않는다.

export interface RefundAccountValue {
  readonly bankCode: string;
  /** 하이픈을 뺀 숫자 */
  readonly accountNumber: string;
  readonly holderName: string;
}

export type RefundAccountShape = { readonly ok: true; readonly value: RefundAccountValue } | { readonly ok: false };

const BANK_CODE = /^[0-9]{2}$/;
const ACCOUNT_RAW = /^[0-9-]{1,30}$/;
const ACCOUNT_DIGITS = /^[0-9]{1,20}$/;
const HOLDER_MAX = 60;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NO = { ok: false } as const;

/** 모양을 본다. 맞으면 하이픈을 뺀 계좌번호와 앞뒤 공백을 뺀 예금주를 돌려준다 */
export function refundAccountShape(v: unknown): RefundAccountShape {
  if (typeof v !== 'object' || v === null) return NO;
  const { bankCode, accountNumber, holderName } = v as Record<string, unknown>;
  if (typeof bankCode !== 'string' || typeof accountNumber !== 'string' || typeof holderName !== 'string') return NO;
  if (!BANK_CODE.test(bankCode) || !ACCOUNT_RAW.test(accountNumber)) return NO;
  const digits = accountNumber.replace(/-/g, '');
  if (!ACCOUNT_DIGITS.test(digits)) return NO;
  const holder = holderName.trim();
  const length = [...holder].length;
  if (length === 0 || length > HOLDER_MAX || CONTROL.test(holder)) return NO;
  return { ok: true, value: { bankCode, accountNumber: digits, holderName: holder } };
}
