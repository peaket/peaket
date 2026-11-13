// 두 경로 묶음이 함께 쓰는 문서 뼈대(<html>·<body>). 키트 루트 클래스 pk를 <body>에 단다(packages/ds/README.md 'CSS 싣기').
// - 색 모드: 소비자 웹은 운영체제 테마를 따른다(docs/design/d1 §4). SEED 색 모드 스크립트(public/seed-color-mode.js, 붙인 SEED 판이 만든
//   글자 그대로, pnpm --filter @peaket/web color-mode)를 같은 출처 파일로 <head>에서 먼저 실어 첫 그림 전에 html에
//   data-seed-user-color-scheme을 단다. 키트 다크 변수와 맨 바깥 color-scheme이 그 값을 따른다(@peaket/ds kit-tokens.css·ds.css).
//   캐시 화면(묶음 A)은 script-src 'self'로 실리고, 요청 화면(B·E·F)은 그 응답의 nonce를 붙인다(d2 §1, HOT-291).
//   다크 미리보기(?theme=dark)는 셸 루트(.pk.dark)가 맡는다.
// - 글꼴: Pretendard 가변 글꼴 동적 서브셋(styles/globals.css, 화면에 쓰인 글자의 조각만 받는다, docs/frontend.md §5.8).
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../styles/globals.css';

export const rootMetadata: Metadata = {
  title: { default: 'PEAKET', template: '%s · PEAKET' },
  description: '공정한 대기열로 여는 공연 예매, PEAKET(피켓)',
  // 홈 화면 바로가기(PWA) 아이콘과 설치 이름(BAS-200). 아이콘 파일은 app/icon.svg·app/apple-icon.png가 만든다
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'PEAKET' },
  // 퍼블리싱 단계: 검색 엔진에 올리지 않는다(경로별 robots는 화면을 잇는 단계에서 정한다)
  robots: { index: false, follow: false },
};

export const rootViewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: '#4338CA',
};

export function RootDocument({ children, nonce }: { children: ReactNode; nonce?: string }) {
  return (
    <html lang="ko" data-seed-color-mode="system" suppressHydrationWarning>
      <head>
        <script src="/seed-color-mode.js" nonce={nonce} />
      </head>
      <body className="pk">
        {/* 서비스 워커는 월렛 화면(WalletPwa)에서만 동적으로 등록한다. 루트 문서에 두면 모든 경로 첫 JS에 Serwist가 들어간다 */}
        {children}
      </body>
    </html>
  );
}
