// 맞는 경로가 없는 주소의 404(app/global-not-found.tsx). 루트 레이아웃을 거치지 않으므로 문서 뼈대·전역 CSS·글꼴을 직접 싣는다.
// 화면 내용은 SCR-059 시스템 안내(discovery 담당)의 '없는 주소' 화면을 쓴다.
import type { Metadata } from 'next';
import { NotFoundScreen } from '@/_pages/system-notice';
import { RootDocument } from './RootDocument';

export const globalNotFoundMetadata: Metadata = { title: '페이지를 찾을 수 없습니다', robots: { index: false, follow: false } };

export function GlobalNotFoundDocument() {
  return (
    <RootDocument>
      <NotFoundScreen />
    </RootDocument>
  );
}
