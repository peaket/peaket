// SCR-047 상태(디자인 캔버스 보드 state 열거값). 데스크톱·태블릿 이름을 쓰고, 휴대폰 보드에만 있는 '제2 승인 대기'를 더했다.
// 휴대폰 보드의 '판정 대기'·'일괄 환불 진행 중'은 '판정'·'일괄 환불 진행'과 같은 상태로 본다(Page.tsx의 PHONE 표).
// 휴대폰 처음 상태는 '제2 승인 대기'다(휴대폰에서 하는 일, d5 §3.9).
export const STATES = ['판정', '확정 직전 확인', '일괄 환불 진행', '자동 정지', '일부 실패로 완료', '반려·연기 처리', '제2 승인 대기'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT = { desktop: '판정', tablet: '판정', phone: '제2 승인 대기' } as const satisfies Record<string, State>;
