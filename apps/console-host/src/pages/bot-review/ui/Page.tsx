// SCR-067 봇 판정 표본 검토(/bot-review, d5 §7.15). 보드 SCR-067-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 cs_lead 준의 화면이다. 위 상태 바: 단계 종료 후 · 자동 제어 정상 · 14:20:05. 개인 식별자 없이 세션 가명만 보인다(d5 §3.7).
// 역할(d5 §3.3): CS 두 역할만 검토한다. 나머지 역할은 메뉴에 없다.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, valsT } from './board-t';

const TITLE = '봇 판정 표본 검토';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'none', operator: 'none', commander: 'none', cs_agent: 'act', cs_lead: 'act' };

export function Page() {
  const chosen = useChosenRole();
  const { state, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT);
  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      clock: '14:20:05 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.cs_lead }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="CS 담당자(cs_agent·cs_lead)" />;
  return (
    <>
      {layout === 'desktop' ? <MainD v={valsD(state)} close={close} go={go} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} go={go} /> : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={STATES} current={state} />
    </>
  );
}
