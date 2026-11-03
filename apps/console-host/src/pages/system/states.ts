// SCR-059 관제 변형 상태(디자인 캔버스 보드 SCR-059-console* state 열거값). '미지원(인앱 브라우저)'는 휴대폰·태블릿 보드에만 있다.
// 보드 기본은 '500'이지만 이 경로는 없는 주소(*)라 처음 값을 '404'로 둔다(추천안).
export const STATES = ['500', '404', '429', '미지원', '미지원(인앱 브라우저)', '화면 불러오기 실패', '화면 불러오기 실패(새 버전)'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '404';
