// F-04-16 운영 빌드 진입점. 콘솔 주소 아래 /forensics/에서 따로 여는 한 페이지다.
import '../styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OperatingApp } from './OperatingApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OperatingApp />
  </StrictMode>,
);
