// 셸 본문(<main class="cs-main">)의 간격·여백을 화면마다 보드 값으로 맞춘다. 화면을 떠나면 키트 기본값으로 돌아간다.
import { useLayoutEffect, type CSSProperties } from 'react';
import { create } from 'zustand';

interface ShellUi {
  mainStyle?: CSSProperties;
  set(style?: CSSProperties): void;
}

export const useShellUi = create<ShellUi>()((set) => ({
  mainStyle: undefined,
  set: (mainStyle) => set({ mainStyle }),
}));

/** 예: useMainStyle({ gap: 12 }) — 보드의 <main class="cs-main" style="gap:12px"> */
export function useMainStyle(style: CSSProperties | undefined, key: string) {
  const setStyle = useShellUi((s) => s.set);
  useLayoutEffect(() => {
    setStyle(style);
    return () => setStyle(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setStyle]);
}
