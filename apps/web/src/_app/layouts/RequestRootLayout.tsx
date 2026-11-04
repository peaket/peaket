// 경로 묶음 (request)의 루트 레이아웃: 헤더 묶음 B·E·F(요청마다 nonce로 그리는 화면, docs/frontend.md §2.5·§5.14.1).
// <html>을 그리기 전에 요청 헤더의 nonce를 읽는다. 요청 값을 맨 바깥에서 읽으므로 이 묶음 전체가 요청 때 그려지고
// 정적 셸이 생기지 않는다(정적 셸 안 스크립트는 요청 nonce를 받지 못한다, FE-T35). app/(request)/layout.tsx가 instant = false를 둔다.
// nonce는 proxy.ts가 요청마다 만들어 요청 헤더 Content-Security-Policy·x-nonce에 싣고, Next.js가 요청 CSP에서 읽어 프레임워크
// 스크립트에 붙인다. nonce가 없으면(proxy를 거치지 않은 요청) 화면을 그리지 않는다. 화면이 직접 싣는 스크립트(사람 확인 위젯·
// SEED 색 모드 스크립트, HOT-291)는 이 값을 넘겨받는다.
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { NONCE_HEADER } from '../security/page-headers';
import { RootDocument } from './RootDocument';

export async function RequestRootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER);
  if (!nonce) throw new Error('요청 화면에 nonce가 없다: proxy.ts의 matcher가 이 경로를 거치는지 본다(docs/frontend.md §5.14.1)');
  return <RootDocument>{children}</RootDocument>;
}
