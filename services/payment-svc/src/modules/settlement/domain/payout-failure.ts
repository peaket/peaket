// 토스 지급 전송·실패의 시간 규칙(F-07-6 LCH-110, settlement §5.2·§12, ADR-0369 결정 7·8).
// - 응답 없음·처리 중·잔액 모자람은 같은 키로 1분에서 두 배씩, 30분 상한 [가정] 간격으로 다시 보낸다.
// - 자동 전송 마감은 지급일 전 은행 영업일 22:00 KST [가정]이다. 넘기면 지급일을 다음 은행 영업일로 미룬다.
// - 지급 건 FAILED의 갈래별 처리: 계좌·모름은 사람, 점검(일시)은 새 순번으로 다음 지급일에 2번까지 [가정], 한도/KYC는 셀러 APPROVED 확인 뒤 한 번.
// 은행 영업일은 지금 주말만 뺀다(F-07-5 C-04, 정리 목록 C-06).
import { addBusinessDays, dateOnly, subtractBusinessDays, type PayoutFailureClass } from './settlement.js';

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/** 같은 지급 건 줄기의 점검 갈래 자동 재요청 상한 [가정] */
export const AUTO_RETRY_LIMIT = 2;
/** 다시 보내기 간격 상한(30분 [가정]) */
export const SUBMIT_BACKOFF_CAP_MS = 30 * MIN_MS;

/** n번째 시도(1부터) 뒤 다음 시도까지의 간격: min(2^(n−1)분, 30분) */
export function submitBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(2 ** (n - 1) * MIN_MS, SUBMIT_BACKOFF_CAP_MS);
}

const isWeekend = (dateKey: string): boolean => {
  const wd = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
};

/** 그 날짜 다음 은행 영업일(주말만 뺀다) */
export const nextBankBusinessDay = (dateKey: string): string => dateOnly(addBusinessDays(new Date(`${dateKey}T00:00:00Z`), 1));

/** 그 날짜 전 은행 영업일 */
export const previousBankBusinessDay = (dateKey: string): string => dateOnly(subtractBusinessDays(new Date(`${dateKey}T00:00:00Z`), 1));

/** 자동 전송 마감: 지급일 전 은행 영업일 22:00 KST [가정] */
export const submitDeadlineFor = (payoutDate: string): Date => new Date(Date.parse(`${previousBankBusinessDay(payoutDate)}T22:00:00+09:00`));

/** 점검 갈래 재요청의 지급일: 내일(KST) 09시 뒤 첫 은행 영업일 [가정] */
export function retryPayoutDate(now: Date): string {
  let key = new Date(now.getTime() + KST_OFFSET_MS + DAY_MS).toISOString().slice(0, 10);
  while (isWeekend(key)) key = new Date(Date.parse(`${key}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return key;
}

/** 실패 갈래별 처리(settlement §12 세 갈래 표, ADR-0369 결정 8) */
export type PayoutFailureAction = 'AUTO_RETRY' | 'HUMAN' | 'AWAIT_SELLER';

export function payoutFailureAction(failureClass: PayoutFailureClass, autoRetryCount: number): PayoutFailureAction {
  if (failureClass === 'TRANSIENT') return autoRetryCount < AUTO_RETRY_LIMIT ? 'AUTO_RETRY' : 'HUMAN';
  if (failureClass === 'LIMIT_KYC') return 'AWAIT_SELLER';
  return 'HUMAN';
}
