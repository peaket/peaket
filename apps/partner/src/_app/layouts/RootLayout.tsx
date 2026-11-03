// 루트 레이아웃: <html lang="ko">, SEED 색 모드 system(d2 §1), <body class="pk">(ds README). 다크 미리보기는 셸·카드 바깥 요소가 ?theme=dark로 .dark를 더한다.
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: { default: 'PEAKET 파트너', template: '%s · PEAKET 파트너' },
  description: 'PEAKET 파트너 콘솔(퍼블리싱 목업)',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" data-seed-color-mode="system">
      <body className="pk">{children}</body>
    </html>
  );
}
