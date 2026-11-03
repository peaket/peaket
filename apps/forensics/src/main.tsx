// 포렌식 리플레이 1단계 데모 진입점(Vite 8 + React, 관제 셸 없이 한 페이지)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
