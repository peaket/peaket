// SCR-046 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드에는 정산서 수기 조정 두 상태가 없다(새 요청은 태블릿 이상, d5 §3.9).
// 부정 예매 조치 상태는 보드에 없는 변형이다(d5 §7.7 '부정 예매 조치' 그림이 시각 기준, add-fraud-investigation-screens design.md 결정 8). 세 배치 모두에 있다.
// 판단 이유·범위 줄이기·요약 열람(ADR-0173 결정 2)의 상태 넷과 오류 둘(d5 §9.2)은 apply-legal-review-to-screens에서 더했다.
// 오류 응답으로만 보이는 화면은 '오류 · <type>' 꼴이다(그 design.md 결정 3). 422 approval-reason-required는 '판단 이유 없음'과 같은 화면이다.
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
  '부정 예매 조치 · 요약을 아직 받지 못함',
  '부정 예매 조치 · 판단 이유 없음',
  '부정 예매 조치 · 범위를 줄임',
  '부정 예매 조치 · 여러 건 한꺼번에',
  '오류 · fraud-summary-not-viewed',
  '오류 · approval-scope-invalid',
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
  '부정 예매 조치 · 요약을 아직 받지 못함': 'approve',
  '부정 예매 조치 · 판단 이유 없음': 'approve',
  '부정 예매 조치 · 범위를 줄임': 'approve',
  '부정 예매 조치 · 여러 건 한꺼번에': 'approve',
  '오류 · fraud-summary-not-viewed': 'approve',
  '오류 · approval-scope-invalid': 'approve',
  '부정 예매 조치 · 요청자 본인': 'own',
  '부정 예매 조치 · 열 수 없음': 'closed',
  '부정 예매 조치 · 취소 마감 지남': 'expired',
};

/** 부정 예매 조치 상태면 그 변형, 아니면 null */
export function fraudVariant(state: string): FraudVariant | null {
  return FRAUD_STATES[state] ?? null;
}

/**
 * 승인자 변형(approve) 안의 그림: 기본 · 요약을 아직 받지 못함 · 판단 이유 없음 · 범위를 줄임 · 여러 건 한꺼번에 · 409 요약 열람 없음 · 422 범위.
 * 대상 줄의 ☑와 판단 이유 칸은 화면 안에서도 바꿀 수 있고, 이 값은 처음 그림만 정한다.
 */
export type FraudMode = 'default' | 'summary-pending' | 'no-reason' | 'reduced' | 'batch' | 'err-summary' | 'err-scope';

const FRAUD_MODES: Partial<Record<string, FraudMode>> = {
  '부정 예매 조치 · 요약을 아직 받지 못함': 'summary-pending',
  '부정 예매 조치 · 판단 이유 없음': 'no-reason',
  '부정 예매 조치 · 범위를 줄임': 'reduced',
  '부정 예매 조치 · 여러 건 한꺼번에': 'batch',
  '오류 · fraud-summary-not-viewed': 'err-summary',
  '오류 · approval-scope-invalid': 'err-scope',
};

export function fraudMode(state: string): FraudMode {
  return FRAUD_MODES[state] ?? 'default';
}
