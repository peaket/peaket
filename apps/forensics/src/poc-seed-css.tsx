// SEED CSS 층 탐침 진입점(FE-T36 PoC). PoC 빌드(PEAKET_POC=seed-css)에서만 묶는다(vite.config.ts).
// 가져오는 차례는 진입점(main.tsx)과 같게 둔다: 전역 CSS(층 순서 선언이 맨 앞)를 다른 무엇보다 먼저 가져온다.
// 부품을 먼저 가져오면 그 부품 CSS의 층이 가장 약한 층이 된다(FE-T36 PoC 2026-11-04에서 관제가 그랬다).
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SeedLayerProbe } from '@peaket/ds/poc/seed-layer-probe';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SeedLayerProbe />
  </StrictMode>,
);
