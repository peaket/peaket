// 경로 묶음 (cached)의 루트 레이아웃: 헤더 묶음 A(CDN이 캐시하는 화면, docs/frontend.md §2.5).
// 요청 값(헤더·쿠키)을 읽지 않는다. Cache Components(next.config.ts cacheComponents)에서 요청 값을 읽지 않는 화면은 빌드 때 그려진다.
// 퍼블리싱 화면처럼 주소 값(?state=·목업 경로 값)을 읽는 화면은 app/(cached)/layout.tsx의 instant = false로 요청 때 통째로 그린다.
// 루트에 Suspense를 두면 문서 뼈대가 먼저 나가 화면의 notFound()가 404 대신 200(소프트 404)으로 굳어서 두지 않는다
// (HOT-290 새 맥락 리뷰). 데이터를 잇는 단계는 이 묶음의 화면이 요청 값을 읽지 않게 하고, 없는 주소의 판정은 정적 부분에서 한다.
import type { ReactNode } from 'react';
import { RootDocument } from './RootDocument';

export function CachedRootLayout({ children }: { children: ReactNode }) {
  return <RootDocument>{children}</RootDocument>;
}
