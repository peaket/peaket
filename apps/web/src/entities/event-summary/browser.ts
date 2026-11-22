// 회차 공개 요약 읽기를 실제 브라우저에 잇는다(규칙은 model.ts). 공개 경로라 토큰 갱신 잠금을 쓰지 않는다.
import { ORIGINS } from '@/shared/config/origins';
import { createEventSummaryReader, type EventSummaryReader } from './model';

/** 화면 하나가 쓰는 읽기 도구. 부르는 화면이 한 번 만들어 둔다(읽은 요약은 그 화면 메모리에만 남는다) */
export function browserEventSummaryReader(): EventSummaryReader {
  return createEventSummaryReader({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init) });
}
