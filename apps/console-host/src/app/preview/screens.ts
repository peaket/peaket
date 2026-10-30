// 관제 화면 목록(/preview, 개발 서버에서만). 등록 파일 A(첫 차례)·B(다음 차례)를 SCR 번호 순으로 합친다.
import type { PreviewScreen } from '@peaket/ds/Preview';
import { SCREENS_A } from './screens.a';
import { SCREENS_B } from './screens.b';

export const SCREENS: readonly PreviewScreen[] = [...SCREENS_A, ...SCREENS_B].sort((a, b) => a.id.localeCompare(b.id));

/** 다른 앱의 화면 목록(개발 포트, add-screen-publishing design.md 결정 6) */
export const OTHER_APPS: readonly { name: string; href: string }[] = [
  { name: '소비자 웹 :3000', href: 'http://localhost:3000/preview' },
  { name: '파트너 콘솔 :3001', href: 'http://localhost:3001/preview' },
  { name: '스캐너 :3003', href: 'http://localhost:3003/preview' },
  { name: '대기실 :3004', href: 'http://localhost:3004/' },
  { name: '포렌식 데모 SCR-069 :3005', href: 'http://localhost:3005/' },
];
