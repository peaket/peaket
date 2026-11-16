'use client';
// 월렛 워커 갱신 토스트를 늦게 불러오는 자리(HOT-390). 셸의 첫 JS에는 이 작은 부품만 든다(첫 JS 예산, docs/frontend.md §5.8).
// 이 기기에 월렛 워커 등록이 있을 때만 WalletUpdateToast 모듈을 불러온다(월렛을 쓰지 않는 방문자는 받지 않는다).
// 등록을 읽지 못하면 토스트를 띄우지 않는다(다음 방문 때 브라우저 기본 규칙).
// (부수 효과로 따로 React 뿌리를 붙이는 꼴도 재 봤으나 react-dom/client가 첫 묶음 쪽으로 옮겨 홈 첫 JS가 0.3kB 더 컸다, BAT-170)
import { useEffect, useState, type ComponentType } from 'react';

export function WalletUpdateLoader() {
  const [Toast, setToast] = useState<ComponentType | null>(null);
  useEffect(() => {
    navigator.serviceWorker
      ?.getRegistration('/my/tickets/')
      .then((r) => r && import('./WalletUpdateToast').then((m) => setToast(() => m.WalletUpdateToast)))
      .catch(() => {});
  }, []);
  return Toast ? <Toast /> : null;
}
