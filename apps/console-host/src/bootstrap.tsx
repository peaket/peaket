// 관제 콘솔 앱 시작(webpack 5 + React Router 8 데이터 라우터, docs/frontend.md §2.3·§5.7). main.tsx가 늦게 싣는다(Module Federation 공유 모듈 협상, ADR-0360).
// 전역 CSS(층 순서 선언이 맨 앞)는 main.tsx가 이 파일보다 먼저 진입 덩어리에서 가져온다(첫 HTML이 싣는다, d2 §1, FE-T36)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from './app/router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
