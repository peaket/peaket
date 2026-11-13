'use client';
// Serwist 등록기(offline-gate §2·§4, docs/frontend.md §2.3·§5.4). 서비스 워커는 /serwist/sw.js가 만든다.
// @serwist/turbopack의 provider를 서버 레이아웃에서 직접 가져오면 RSC에서 hooks가 돌아 오류가 난다(9.5.10 이슈).
// 이 파일을 'use client' 경계로 두어 브라우저에서만 등록한다.
export { SerwistProvider } from '@serwist/turbopack/react';
