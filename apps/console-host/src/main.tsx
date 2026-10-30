// 관제 콘솔 진입점(webpack 5 + React Router 8 데이터 라우터, docs/frontend.md §2.3·§5.7)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from './app/router';
import './app/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
