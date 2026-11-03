// 관제 화면 테마(d2 §1, d5 §7.1 '화면 설정'): 자동 = 데스크톱 배치 다크 · 휴대폰·태블릿 배치 기기 설정. /me에서 다크·라이트로 바꾼다.
// 운영자 설정은 이 브라우저에만 남긴다(저장소 접근이 막혀도 화면은 그대로 그린다). ?theme=dark|light는 퍼블리싱 미리보기용 덮어쓰기.
import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { ConsoleLayout } from '@peaket/ds/ConsoleShell';

export type ThemePref = 'auto' | 'dark' | 'light';

const KEY = 'peaket.console.ui';

function load(): { theme: ThemePref; singleKey: boolean } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { theme?: ThemePref; singleKey?: boolean };
      return { theme: v.theme === 'dark' || v.theme === 'light' ? v.theme : 'auto', singleKey: v.singleKey === true };
    }
  } catch {
    /* 저장소를 쓸 수 없으면 처음 값 */
  }
  return { theme: 'auto', singleKey: false };
}

interface UiPrefs {
  theme: ThemePref;
  /** 한 글자 단축키(처음에는 꺼짐, d5 §3.3) */
  singleKey: boolean;
  setTheme(t: ThemePref): void;
  setSingleKey(on: boolean): void;
}

function save(s: { theme: ThemePref; singleKey: boolean }) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 무시 */
  }
}

export const useUiPrefs = create<UiPrefs>()((set, get) => ({
  ...load(),
  setTheme: (theme) => {
    set({ theme });
    save({ theme, singleKey: get().singleKey });
  },
  setSingleKey: (singleKey) => {
    set({ singleKey });
    save({ theme: get().theme, singleKey });
  },
}));

function subscribeScheme(cb: () => void) {
  const m = window.matchMedia('(prefers-color-scheme: dark)');
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

/** 지금 그릴 테마. override는 주소의 ?theme= 값 */
export function useResolvedTheme(layout: ConsoleLayout, override: string | null): 'dark' | 'light' {
  const pref = useUiPrefs((s) => s.theme);
  const osDark = useSyncExternalStore(subscribeScheme, () => window.matchMedia('(prefers-color-scheme: dark)').matches, () => true);
  if (override === 'dark' || override === 'light') return override;
  if (pref !== 'auto') return pref;
  return layout === 'desktop' ? 'dark' : osDark ? 'dark' : 'light';
}

/** <body class="pk">에 dark를 붙이거나 뗀다(키트 색 변수가 .pk.dark 아래에서 바뀐다) */
export function useBodyTheme(theme: 'dark' | 'light') {
  useEffect(() => {
    document.body.classList.add('pk');
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);
}
