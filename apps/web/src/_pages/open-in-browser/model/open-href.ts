// SCR-058 외부 브라우저 전환 안내의 열 주소(docs/design/d5-screen-blueprint.md §5.32 '열 주소', BUILD_ORDER HOT-380).
// next가 같은 출처의 대기실 경로(/queue/{eventId})나 티켓 경로(/my/tickets/{ticketId}) 꼴이면 그 경로를 그대로, 아니면 첫 화면(/).
// 고정 자료(공연·티켓)를 찾지 않는 순수 함수라 target.ts가 이것을 쓰고 node --test가 바로 부른다.
// - 받은 주소(다른 출처, `//`·`/\`로 시작하는 주소, 같은 호스트의 절대 주소 포함)는 어디에도 싣지 않는다(열린 이동 막기, ASVS 3.7.2).
// - 질의·`#`·더 깊은 경로가 붙은 주소는 두 꼴 밖이라 첫 화면이다. 고정 자료에 없는 공연·티켓 ID도 꼴이 맞으면 그대로 연다
//   (데모 공연으로 바꾸지 않는다, BAT-170 시험 뒤 정함 계획 §11 3).

/** 대기실 경로: `/queue/{eventId}` */
export const QUEUE_PATH = /^\/queue\/([a-z0-9-]{1,64})$/;
/** 티켓 경로: `/my/tickets/{ticketId}` */
export const TICKET_PATH = /^\/my\/tickets\/([a-z0-9-]{1,64})$/;

/** [다른 브라우저로 열기]·[주소 복사]가 쓸 같은 출처 경로 */
export function openTargetPath(next: string | undefined): string {
  if (typeof next !== 'string') return '/';
  return QUEUE_PATH.test(next) || TICKET_PATH.test(next) ? next : '/';
}
