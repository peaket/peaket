// 결제 결과의 문구(d5 §9.2). 화면 첫 묶음에서 쓰므로 기계(xstate)와 나눈다.

const FAILURE: Record<string, string> = {
  CARD_DECLINED: '카드사에서 결제를 승인하지 않아 좌석이 해제되었습니다. 요금은 청구되지 않았습니다. 좌석을 다시 골라 주세요',
  SEAT_TAKEN: '좌석이 이미 판매되어 결제되지 않았습니다. 요금은 청구되지 않습니다',
  EXPIRED: '결제 승인 시간이 지나 결제되지 않았습니다. 요금은 청구되지 않습니다',
};

/** 실패 사유별 문구(d5 §9.2). 모르는 사유는 일반 문구다 */
export const failureText = (reason: string | undefined): string => (reason ? FAILURE[reason] : undefined) ?? '결제를 처리하지 못해 좌석이 해제되었습니다. 요금은 청구되지 않았습니다. 좌석을 다시 골라 주세요';
