// SCR-027 정산 리포트·명단 상태(보드 SCR-027-m·t·d). 상태가 하위 탭도 정한다:
// 정산서 탭 6 · 판매 요약 탭 2 · 예매자 명단 탭 6 · 다운로드 이력 탭 3. '…실무자 보기'와 ?role=member는 파트너 실무자로 그린다.
export const SETTLEMENT_STATES = [
  '정산',
  'KYC 예고',
  '이의 제기 대화상자',
  '이의 기간 끝',
  '재통지(조정)',
  '재통지(기각)',
  '판매 요약',
  '판매 요약 확정 전',
  '예매자 명단',
  '다운로드 대화상자',
  '사유 없음 오류',
  '내려받는 중',
  '명단 실무자 보기',
  '보유 기간 끝',
  '다운로드 이력',
  '다운로드 이력 없음',
  '다운로드 이력 실무자 보기',
] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** 이 화면에서만 파트너 실무자로 그리는 상태(셸 계정 메뉴는 ?role=member를 함께 줘야 '파트너 실무자'가 된다) */
export const SETTLEMENT_MEMBER_STATES: readonly SettlementState[] = ['명단 실무자 보기', '다운로드 이력 실무자 보기'];
