// /me 화면 설정이 바꾸는 운영자 설정(이 브라우저에만 남는다, d5 §7.1)
import type { ThemePref } from '@/shared/lib/theme';

export interface MePrefs {
  theme: ThemePref;
  singleKey: boolean;
  setTheme(t: ThemePref): void;
  setSingleKey(on: boolean): void;
}
