export { EventDetailPage as default, generateMetadata, generateStaticParams } from '@/_pages/event-detail';

// 미리 그리지 않은 회차는 처음 요청 때 끝까지 그려 회차 주소마다 ISR 항목으로 둔다(Next.js 'ISR with Cache Components'의 막는 길).
// 경로 값을 Suspense 밖에서 읽으므로 즉시 이동 셸을 두지 않는다고 표시한다(BUILD_ORDER HOT-311)
export const instant = false;
