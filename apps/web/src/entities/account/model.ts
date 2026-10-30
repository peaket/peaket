// 계정 쪽 공용 목업(account 담당). 은행 목록은 환불·배상 계좌 폼(CMP-062 BankAccountForm)이 함께 쓴다.
// 계좌번호·예금주는 화면에 끝 4자리만 보인다(저장하지 않는다는 안내, POL-014·POL-039). 값은 모두 합성이다.

/** 계좌 폼 은행 목록(선택지 값·이름) */
export const BANKS: readonly { value: string; label: string }[] = [
  { value: 'kb', label: '국민은행' },
  { value: 'shinhan', label: '신한은행' },
  { value: 'woori', label: '우리은행' },
  { value: 'hana', label: '하나은행' },
  { value: 'nh', label: '농협은행' },
  { value: 'ibk', label: '기업은행' },
  { value: 'kakao', label: '카카오뱅크' },
  { value: 'toss', label: '토스뱅크' },
];

/** 입력해 둔 모양(요청 중·오류 상태)의 합성 값. 실제 계좌가 아니다 */
export const SAMPLE_BANK_INPUT = { bank: 'kb', account: '00000012345678', holder: '김지민' } as const;

/** 은행 이름 + 끝 4자리(완료 화면 표시) */
export function maskedAccount(bankValue: string, account: string): string {
  const bank = BANKS.find((b) => b.value === bankValue)?.label ?? '은행';
  return `${bank} 끝 ${account.slice(-4)}`;
}
