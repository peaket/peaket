// SCR-031 상태(디자인 캔버스 보드 state 열거값). '재생 중'은 휴대폰 보드에 없다(휴대폰은 리플레이 플레이어가 범위 밖, d5 §3.9).
export const STATES = ['기본', '재생 중', '빈 결과', '명단 다운로드 기록', '체인 변조', '공개 타임스탬프 대기', '공개 앵커 지연'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '기본';
