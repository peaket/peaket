// 환불·배상 계좌 모양 한 규칙(docs/features/payment.md §6 '구현에서 정한 것' ②⑦, §11 P-T74, BAT-420-rest 리뷰 반영 RV-04, BAT-425 RN-01).
// bankCode는 토스 은행 코드 표의 두 자리 26개 허용 목록만, accountNumber는 숫자와 하이픈 1~30자이고 하이픈을 뺀 숫자 1~20자, holderName은 1~60자(앞뒤 공백을 뺀 길이, 제어 문자 없음)다.
// purchase-svc·core-svc 본문 검사(틀리면 400 invalid-body)가 쓰고, payment-svc refundAccountOf도 같은 목록으로 한 번 더 막는다(깊은 방어).
// 목록은 payment-svc payment-gateway.ts의 PORTONE_BANK_OF와 같게 둔다(두 표가 어긋나면 P-T74 ②가 잡는다). 던지지 않고 값을 글에 싣지 않는다.

export interface RefundAccountValue {
  readonly bankCode: string;
  /** 하이픈을 뺀 숫자 */
  readonly accountNumber: string;
  readonly holderName: string;
}

export type RefundAccountShape = { readonly ok: true; readonly value: RefundAccountValue } | { readonly ok: false };

const BANK_CODE = /^[0-9]{2}$/;
/**
 * 화면과 검사가 같은 은행 목록을 쓴다(토스페이먼츠 '은행 코드 및 증권사 코드'의 두 자리 코드 26개, 2026-11-19 확인).
 * 순서는 코드 오름차순이고 화면은 이 순서대로 보인다. 화면에 표를 복제하지 않는다.
 */
export const REFUND_BANKS: readonly { readonly code: string; readonly label: string }[] = Object.freeze([
  { code: '02', label: 'KDB산업은행' },
  { code: '03', label: 'IBK기업은행' },
  { code: '06', label: 'KB국민은행' },
  { code: '07', label: '수협은행' },
  { code: '11', label: 'NH농협은행' },
  { code: '12', label: '지역농협' },
  { code: '20', label: '우리은행' },
  { code: '23', label: 'SC제일은행' },
  { code: '27', label: '한국씨티은행' },
  { code: '31', label: '대구은행' },
  { code: '32', label: '부산은행' },
  { code: '34', label: '광주은행' },
  { code: '35', label: '제주은행' },
  { code: '37', label: '전북은행' },
  { code: '39', label: '경남은행' },
  { code: '45', label: '새마을금고' },
  { code: '48', label: '신협' },
  { code: '50', label: '저축은행' },
  { code: '54', label: 'HSBC은행' },
  { code: '64', label: '산림조합' },
  { code: '71', label: '우체국' },
  { code: '81', label: '하나은행' },
  { code: '88', label: '신한은행' },
  { code: '89', label: '케이뱅크' },
  { code: '90', label: '카카오뱅크' },
  { code: '92', label: '토스뱅크' },
]);

/** 검사용 코드 집합. 목록 밖 두 자리(예 99·04)는 받지 않는다 */
export const REFUND_BANK_CODES: ReadonlySet<string> = new Set(REFUND_BANKS.map((b) => b.code));

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
  if (!BANK_CODE.test(bankCode) || !REFUND_BANK_CODES.has(bankCode) || !ACCOUNT_RAW.test(accountNumber)) return NO;
  const digits = accountNumber.replace(/-/g, '');
  if (!ACCOUNT_DIGITS.test(digits)) return NO;
  const holder = holderName.trim();
  const length = [...holder].length;
  if (length === 0 || length > HOLDER_MAX || CONTROL.test(holder)) return NO;
  return { ok: true, value: { bankCode, accountNumber: digits, holderName: holder } };
}
