// SCR-046 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드에는 정산서 수기 조정 두 상태가 없다(새 요청은 태블릿 이상, d5 §3.9).
// 부정 예매 조치 넷은 보드에 없는 변형이다(d5 §7.7 '부정 예매 조치' 그림이 시각 기준, add-fraud-investigation-screens design.md 결정 8). 세 배치 모두에 있다.
export const STATES = [
  '승인 대기',
  '요청자 본인',
  '실행 직전 재인증',
  '실행 직전 재인증 — commander',
  '재인증 · 패스키 확인',
  '재인증 · 패스키 확인 실패',
  '실행 실패',
  '권한 밖 승인',
  '정산서 수기 조정(이의 없음)',
  '수기 조정 · 지급 요청 뒤(409)',
  '부정 예매 조치',
  '부정 예매 조치 · 요청자 본인',
  '부정 예매 조치 · 열 수 없음',
  '부정 예매 조치 · 취소 마감 지남',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '승인 대기';

/** 부정 예매 조치 상태 → 공용 패널(FraudActionPanel)의 변형 */
export type FraudVariant = 'approve' | 'own' | 'closed' | 'expired';

export const FRAUD_STATES: Partial<Record<string, FraudVariant>> = {
  '부정 예매 조치': 'approve',
  '부정 예매 조치 · 요청자 본인': 'own',
  '부정 예매 조치 · 열 수 없음': 'closed',
  '부정 예매 조치 · 취소 마감 지남': 'expired',
};

/** 부정 예매 조치 상태면 그 변형, 아니면 null */
export function fraudVariant(state: string): FraudVariant | null {
  return FRAUD_STATES[state] ?? null;
}
