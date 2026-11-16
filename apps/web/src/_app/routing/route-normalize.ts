// 캐시 화면 경로의 정규 주소 표(W7L2-S10, docs/frontend.md §5.18 '공유 캐시 처리기 세부' '정규 주소 하나로 모은다', 계획 §16).
// proxy.ts와 일곱 화면이 함께 쓴다. 시험 담당이 먼저 둔 빈 뼈대다(ADR-0270 결정 3). 표와 판정은 구현 담당이 쓴다.

export type RouteDecision = { kind: 'ok' } | { kind: 'redirect'; location: string } | { kind: 'not-found' };

/** 경로(와 쿼리)를 정본 꼴과 견준다: 그대로면 ok, 대소문자·퍼센트 감싸기만 다르면 정본 주소로 308(쿼리 보존), 꼴 밖이면 404. 표 밖의 경로는 ok */
export function normalizeRoute(pathname: string, search = ''): RouteDecision {
  void pathname, search;
  throw new Error('아직 없음');
}
