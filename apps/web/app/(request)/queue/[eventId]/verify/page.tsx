export { QueueVerifyPage as default, metadata } from '@/_pages/queue-verify';

// 상태 읽기(GET …/verification)와 탭 저장소의 값으로 그리는 화면이다. 요청마다 그리므로 즉시 뜨는 정적 셸을 두지 않는다(docs/frontend.md §5.2 '요청마다 셸')
export const instant = false;
