// 다른 앱 주소. 포렌식 리플레이(SCR-069)는 관제 콘솔 주소 아래 따로 여는 페이지 /forensics다(docs/features/forensic-replay.md §6.8).
// 개발 서버에서는 따로 띄운 포렌식 데모 앱(포트 3005)으로 잇는다. __PREVIEW__는 빌드 때 글자로 바뀌어 운영 묶음에 개발 주소가 남지 않는다.
export const FORENSICS_BASE: string = __PREVIEW__ ? 'http://localhost:3005/' : '/forensics';

/**
 * 사건 작업대에서 여는 조사 원천 리플레이 주소(새 탭, rel="noopener"). 정본은 '연 길이 원천을 정한다'이고(§4.2·§6.8),
 * 퍼블리싱에서는 연 길 대신 ?source=조사로 원천을 고른다(add-fraud-investigation-screens design.md 결정 7).
 */
export function investigationReplayHref(eventId: string, caseId: string): string {
  const q = new URLSearchParams({ source: '조사', event: eventId, case: caseId });
  return `${FORENSICS_BASE}?${q.toString()}`;
}
