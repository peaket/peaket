// 루트 레이아웃: <html lang="ko">, SEED 색 모드 system(d2 §1), <body class="pk">(ds README). 다크 미리보기는 셸·카드 바깥 요소가 ?theme=dark로 .dark를 더한다.
// <head> 맨 앞에 좁은 기본 Trusted Types 정책 스크립트(같은 출처 파일, 요청 nonce·무결성)를 실어 Next.js 덩어리보다 먼저 정책을 만든다(OPS-340, ADR-0360 결정 7).
// 요청 머리의 nonce를 읽으므로 모든 화면이 요청 때 그려진다(정적 셸 안 스크립트는 요청 nonce를 받지 못한다, 소비자 웹 FE-T35와 같은 까닭).
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { NONCE_HEADER, TRUSTED_TYPES_DEFAULT_SRC, TRUSTED_TYPES_DEFAULT_SRI } from '@/shared/config/security';
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <html lang="ko" data-seed-color-mode="system">
      <head>
        <script src={TRUSTED_TYPES_DEFAULT_SRC} nonce={nonce} integrity={TRUSTED_TYPES_DEFAULT_SRI} />
      </head>
      <body className="pk">{children}</body>
    </html>
  );
}
