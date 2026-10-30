// 콘솔 배치(d5 §3.9, 키트 20b절): 휴대폰 768 미만 · 태블릿 768~1279 · 데스크톱 1280 이상(SEED 중단점).
// 키트는 배치를 클래스(.cs-compact·.is-tab)로 고르므로 창 폭을 matchMedia로 읽어 셸과 화면이 같은 배치를 쓴다.
import { useSyncExternalStore } from 'react';
import type { ConsoleLayout } from '@peaket/ds/ConsoleShell';

const LG = '(min-width: 1280px)';
const MD = '(min-width: 768px)';

function subscribe(cb: () => void) {
  const a = window.matchMedia(LG);
  const b = window.matchMedia(MD);
  a.addEventListener('change', cb);
  b.addEventListener('change', cb);
  return () => {
    a.removeEventListener('change', cb);
    b.removeEventListener('change', cb);
  };
}

function snapshot(): ConsoleLayout {
  if (window.matchMedia(LG).matches) return 'desktop';
  if (window.matchMedia(MD).matches) return 'tablet';
  return 'phone';
}

export function useLayout(): ConsoleLayout {
  return useSyncExternalStore(subscribe, snapshot, () => 'desktop');
}

/** xl 1440 이상(대시보드 4열) */
export function useIsXl(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(min-width: 1440px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(min-width: 1440px)').matches,
    () => true,
  );
}
