// SCR-038 예매 취소: 상태별로 보이는 구역(캔버스 보드 SCR-038-m renderVals를 그대로 옮겼다), 취소 수수료 기준표, 환급액 계산.
import type { Scr038State } from '@/shared/config/screens.booking';

export type CancelSheet = 'reauth' | 'final' | 'expired' | 'postFinal';
export type CancelResult = 'pending' | 'hold' | 'check' | 'void' | 'delay';

export interface CancelView {
  /** 좌석 고르기·기준표·환급 예상액·입장 시작 유의(취소 모드) */
  formView: boolean;
  /** 연기 환급 모드(공제 없음) */
  postponed: boolean;
  /** 양도 요청 중이라 불가(409): 오류 요약·좌석 비활성 */
  xfer: boolean;
  /** 환급 예상액 계산 중(스켈레톤) */
  calculating: boolean;
  /** 공연 시작 뒤(CMP-046 취소 불가) */
  cannot: boolean;
  /** 취소 결과 카드 */
  result: CancelResult | null;
  sheet: CancelSheet | null;
}

export function cancelView(st: Scr038State): CancelView {
  const sel = st === '선택';
  const calc = st === '계산 중';
  const reauth = st === '재인증';
  const fin = st === '최종 확인 시트';
  const xfer = st === '양도 요청 중이라 불가';
  const expired = st === '재인증 만료';
  const post = st === '연기 환급';
  const postFin = st === '연기 환급 최종 확인';
  const ready = sel || reauth || fin || expired;
  const result: CancelResult | null =
    st === '취소 처리 중'
      ? 'pending'
      : st === '입장 시작 뒤 접수'
        ? 'hold'
        : st === '취소 확인 중'
          ? 'check'
          : st === '취소 무효'
            ? 'void'
            : st === '결제사 지연'
              ? 'delay'
              : null;
  return {
    formView: ready || calc || xfer,
    postponed: post || postFin,
    xfer,
    calculating: calc,
    cannot: st === '취소 불가',
    result,
    sheet: reauth ? 'reauth' : fin ? 'final' : expired ? 'expired' : postFin ? 'postFinal' : null,
  };
}

/** 취소할 수 있는 좌석(같은 주문의 두 장, 보드 값). id는 entities/ticket의 티켓 id다(좌석 글은 보드를 따른다) */
export interface CancelSeat {
  ticketId: string;
  /** 'R구역 12열 8번' */
  seat: string;
  grade: string;
  price: number;
  gate: string;
}

export const CANCEL_SEATS: readonly CancelSeat[] = [
  { ticketId: 'tkt-lumen-r1-0312', seat: 'R구역 12열 7번', grade: 'R석', price: 154000, gate: '게이트 동문' },
  { ticketId: 'tkt-lumen-r1-0313', seat: 'R구역 12열 8번', grade: 'R석', price: 154000, gate: '게이트 동문' },
];

/** 예매번호(보드 값) */
export const BOOKING_NO = '2026101400123';

/** 결제 수단 표시(보드 m·d는 카드 끝 1234, 보드 t는 가상계좌) */
export const CARD_REFUND_TEXT = '결제한 카드(끝 1234)';

/** 취소 수수료 기준표(POL-032, 소비자분쟁해결기준 공연업). current는 지금 적용되는 줄(공연 5일 전 → 6~3일 전) */
export const FEE_TABLE: readonly { when: string; fee: string; current?: boolean }[] = [
  { when: '예매 후 24시간 안(공연 3일 전까지)', fee: '없음' },
  { when: '공연 10일 전까지', fee: '없음' },
  { when: '9~7일 전', fee: '10%' },
  { when: '6~3일 전', fee: '20%', current: true },
  { when: '2~1일 전', fee: '30%' },
  { when: '공연 당일(시작 전)', fee: '90%' },
];

/** 지금 공제율(기준점: 1% = 100). 공연 5일 전 → 20% */
export const CURRENT_FEE_BP = 2000;
export const CURRENT_FEE_TEXT = '20%';
/** 공연 당일 공제율(입장 시작 뒤 접수·취소 확인 중 결과 카드) */
export const SAME_DAY_FEE_BP = 9000;

/** 공제액 = 티켓 금액 × 기준점 ÷ 10,000(원 미만 버림), 환급액 = 티켓 금액 − 공제액(POL-032 정수 연산) */
export function refundOf(price: number, bp: number): { deduction: number; refund: number } {
  const deduction = Math.floor((price * bp) / 10000);
  return { deduction, refund: price - deduction };
}
