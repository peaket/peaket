// 두 경로 묶음이 함께 쓰는 문서 뼈대(<html>·<body>). SEED 색 모드는 OS 설정(system)을 따르고, 키트 루트 클래스 pk를 <body>에 단다
// (packages/ds/README.md 'CSS 싣기'). 다크 미리보기(?theme=dark)는 셸 루트(.pk.dark)가 맡는다.
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { pretendard } from '../fonts';
import '../styles/globals.css';

export const rootMetadata: Metadata = {
  title: { default: 'PEAKET', template: '%s · PEAKET' },
  description: '공정한 대기열로 여는 공연 예매, PEAKET(피켓)',
  // 퍼블리싱 단계: 검색 엔진에 올리지 않는다(경로별 robots는 HOT-290에서 정한다)
  robots: { index: false, follow: false },
};

export const rootViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" data-seed-color-mode="system" className={pretendard.variable}>
      <body className="pk">{children}</body>
    </html>
  );
}
