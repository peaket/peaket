// 자리 표시 페이지 = 셸 + <h1> 화면 이름 + "퍼블리싱 예정 · SCR-0NN" 한 줄. 셸 변형은 d5 §2 인벤토리의 셸 열을 따른다.
// 각 담당은 자기 src/_pages/<화면 폴더>/의 페이지를 실제 화면으로 바꾼다(app/ 경로 파일은 그대로 둔다).
import type { WebShellFocusInfo } from '@peaket/ds/WebShell';
import { ScreenPlaceholder } from '@/shared/ui/ScreenPlaceholder';
import { AppShell } from './AppShell';

/** 집중 셸 자리 표시의 공연명·회차(E-1 첫 회차) */
const DEMO_FOCUS: WebShellFocusInfo = {
  title: 'LUMEN 콘서트 2026 서울',
  subtitle: '10/25(일) 18:00 · 피켓 아레나',
  closeHref: '/events/evt-lumen-1025',
};

export interface PlaceholderScreenProps {
  scr: string;
  name: string;
  shell?: 'default' | 'focus' | 'staff';
  note?: string;
  current?: 'home' | 'events' | 'upcoming' | 'shop';
}

export function PlaceholderScreen({ scr, name, shell = 'default', note, current }: PlaceholderScreenProps) {
  return (
    <AppShell
      variant={shell}
      current={current ?? null}
      focus={shell === 'focus' ? DEMO_FOCUS : undefined}
      staff={shell === 'staff' ? { closeHref: '/' } : undefined}
    >
      <ScreenPlaceholder scr={scr} name={name} note={note} />
    </AppShell>
  );
}
