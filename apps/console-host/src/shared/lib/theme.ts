// 관제 화면 테마(d2 §1, d5 §7.1 '화면 설정'): 자동 = 데스크톱 배치 다크 · 휴대폰·태블릿 배치 기기 설정. /me에서 다크·라이트로 바꾼다.
// 운영자 설정(테마·한 글자 단축키·접은 위젯)은 이 브라우저에만 남긴다(peaket.console.ui, frontend §3.12. 저장소 접근이 막혀도 화면은 그대로 그린다).
// ?theme=dark|light는 퍼블리싱 미리보기용 덮어쓰기.
import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { ConsoleLayout } from '@peaket/ds/ConsoleShell';

export type ThemePref = 'auto' | 'dark' | 'light';

const KEY = 'peaket.console.ui';

type Stored = { theme: ThemePref; singleKey: boolean; collapsed: readonly string[] };

/** 접은 위젯 이름은 정해진 꼴만(케밥 표기) 64개 [가정]까지 둔다 */
const WIDGET_NAME = /^[a-z][a-z0-9-]{0,63}$/;

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { theme?: ThemePref; singleKey?: boolean; collapsed?: unknown };
      const collapsed = Array.isArray(v.collapsed) ? v.collapsed.filter((n): n is string => typeof n === 'string' && WIDGET_NAME.test(n)).slice(0, 64) : [];
      return { theme: v.theme === 'dark' || v.theme === 'light' ? v.theme : 'auto', singleKey: v.singleKey === true, collapsed };
    }
  } catch {
    /* 저장소를 쓸 수 없으면 처음 값 */
  }
  return { theme: 'auto', singleKey: false, collapsed: [] };
}

interface UiPrefs extends Stored {
  /** 한 글자 단축키(처음에는 꺼짐, d5 §3.3) */
  singleKey: boolean;
  /** 접은 위젯(위젯 이름, d5 §3.3 '접은 위젯', frontend §3.12 peaket.console.ui) */
  collapsed: readonly string[];
  setTheme(t: ThemePref): void;
  setSingleKey(on: boolean): void;
  setCollapsed(widget: string, on: boolean): void;
}

function save(s: Stored) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 무시 */
  }
}

const stored = (s: Stored): Stored => ({ theme: s.theme, singleKey: s.singleKey, collapsed: s.collapsed });

export const useUiPrefs = create<UiPrefs>()((set, get) => ({
  ...load(),
  setTheme: (theme) => {
    set({ theme });
    save(stored(get()));
  },
  setSingleKey: (singleKey) => {
    set({ singleKey });
    save(stored(get()));
  },
  setCollapsed: (widget, on) => {
    if (!WIDGET_NAME.test(widget)) return;
    const rest = get().collapsed.filter((n) => n !== widget);
    set({ collapsed: on ? [...rest, widget].slice(-64) : rest });
    save(stored(get()));
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
