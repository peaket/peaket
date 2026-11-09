// 포렌식 리플레이 1단계 데모 진입점(Vite 8 + React, 관제 셸 없이 한 페이지)
// 전역 CSS(층 순서 선언이 맨 앞)를 다른 무엇보다 먼저 가져온다. 부품 CSS가 먼저 묶이면 그 층이 가장 약한 층이 된다(d2 §1, FE-T36)
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
