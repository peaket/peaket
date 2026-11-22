// 회차 공개 요약(GET /v1/events/{eventId}의 공연명·회차 시작·판매자 상호). 현장 스태프 화면(SCR-050·051·061)이 쓴다(ADR-0362 결정 1).
// 이 파일은 경로 별칭 없이 읽힌다(흐름 모듈의 node 시험·실제 서버 연결 시험). 브라우저용 읽기 도구는 browser.ts에 있다.
export { createEventSummaryReader, eventSummaryOf, readEventSummaries, type EventSummary, type EventSummaryAnswer, type EventSummaryReader } from './model.ts';
