// 경로 묶음 (request)의 루트 레이아웃: 헤더 묶음 B·E·F(요청마다 nonce로 그리는 화면, docs/frontend.md §2.5).
// 정본은 이 레이아웃이 <html>을 그리기 전에 요청 헤더의 nonce를 읽고 `instant = false`를 두는 것이다.
// 퍼블리싱 단계에서는 요청 값을 읽지 않는다(Cache Components·nonce는 HOT-290, add-screen-publishing design.md 결정 6).
import type { ReactNode } from 'react';
import { RootDocument } from './RootDocument';

export function RequestRootLayout({ children }: { children: ReactNode }) {
  return <RootDocument>{children}</RootDocument>;
}
