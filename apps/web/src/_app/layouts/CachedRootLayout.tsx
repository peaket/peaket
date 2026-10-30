// 경로 묶음 (cached)의 루트 레이아웃: 헤더 묶음 A(CDN이 캐시하는 화면, docs/frontend.md §2.5).
// 요청 값(헤더·쿠키)을 읽지 않는다. Cache Components는 PoC FE-T35(HOT-290)에서 켠다.
import type { ReactNode } from 'react';
import { RootDocument } from './RootDocument';

export function CachedRootLayout({ children }: { children: ReactNode }) {
  return <RootDocument>{children}</RootDocument>;
}
