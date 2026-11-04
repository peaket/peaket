// 관제 콘솔 진입점(webpack 5 + React Router 8 데이터 라우터, docs/frontend.md §2.3·§5.7)
// 전역 CSS(층 순서 선언이 맨 앞)를 다른 무엇보다 먼저 가져온다. 부품 CSS가 먼저 묶이면 그 층이 가장 약한 층이 된다(d2 §1, FE-T36)
import './app/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from './app/router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
