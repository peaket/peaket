// 배치: 휴대폰 768 미만 · 태블릿 768~1279 · 데스크톱 1280 이상(SEED 중단점, d5 §3.9). xl 1440부터 오른쪽 패널을 보드 폭(460)으로 둔다.
import { useSyncExternalStore } from 'react';

export type Layout = 'phone' | 'tablet' | 'desktop';

const QUERIES = ['(min-width: 1280px)', '(min-width: 768px)', '(min-width: 1440px)'];

function subscribe(cb: () => void) {
  const mqs = QUERIES.map((q) => window.matchMedia(q));
  mqs.forEach((m) => m.addEventListener('change', cb));
  return () => mqs.forEach((m) => m.removeEventListener('change', cb));
}

function snapshot(): string {
  const [lg, md, xl] = QUERIES.map((q) => window.matchMedia(q).matches);
  return lg ? (xl ? 'desktop-xl' : 'desktop') : md ? 'tablet' : 'phone';
}

export function useLayout(): { layout: Layout; xl: boolean } {
  const s = useSyncExternalStore(subscribe, snapshot, () => 'desktop-xl');
  return { layout: s.startsWith('desktop') ? 'desktop' : (s as Layout), xl: s === 'desktop-xl' };
}
