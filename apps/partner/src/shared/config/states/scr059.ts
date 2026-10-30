// SCR-059 시스템 안내 파트너 변형 상태(보드 SCR-059-partner·-t·-m). '미지원(인앱 브라우저)'는 휴대폰·태블릿 보드에만 있다.
// d5 §5.33: 계획된 정비용 '점검 중' 화면은 두지 않는다(정비 중 짧은 오류는 500 변형). 판매 일시 중단·오프라인은 팬 웹 변형이다.
export const NOTICE_STATES = ['404', '500', '429', '미지원 브라우저', '미지원(인앱 브라우저)'] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];
