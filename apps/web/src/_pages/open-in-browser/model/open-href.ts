// SCR-058 외부 브라우저 전환 안내의 열 주소(docs/design/d5-screen-blueprint.md §5.32 '열 주소', BUILD_ORDER HOT-380).
// next가 같은 출처의 대기실 경로(/queue/{eventId})나 티켓 경로(/my/tickets/{ticketId}) 꼴이면 그 경로를 그대로, 아니면 첫 화면(/).
// 고정 자료(공연·티켓)를 찾지 않는 순수 함수라 target.ts가 이것을 쓰고 node --test가 바로 부른다.
// 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 시험 뒤 정한 것, 계획 §11 3, ADR-0270 결정 3). 동작은 구현 담당이 쓴다.

/** [다른 브라우저로 열기]·[주소 복사]가 쓸 같은 출처 경로 */
export function openTargetPath(next: string | undefined): string {
  void next;
  throw new Error('아직 없음');
}
