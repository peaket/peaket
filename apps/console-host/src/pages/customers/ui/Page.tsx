// SCR-066 팬 조회(/customers, d5 §7.14). 보드 SCR-066-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 cs_agent 다은의 화면이다. 위 상태 바: 단계 종료 후 · 자동 제어 정상 · 내 승인 대기 0 · 14:02:31.
// 역할(d5 §3.3): viewer는 메뉴에 없음, operator·commander는 조회, CS 두 역할은 처리.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

const TITLE = '팬 조회';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'none', operator: 'act', commander: 'act', cs_agent: 'act', cs_lead: 'act' };

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 열람 사유 대화상자와 열람 뒤 화면이 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '열람 사유 대화상자': null,
    '열람 뒤': null,
  },
};

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT, GAPS);
  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      commands: { myApprovals: 0 },
      clock: '14:02:31 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.cs_agent }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="operator·commander·CS 담당자" />;
  return (
    <>
      {layout === 'desktop' ? (
        <>
          <MainD v={valsD(state)} close={close} go={go} />
          <OverlaysD v={valsD(state)} close={close} go={go} />
        </>
      ) : null}
      {layout === 'tablet' ? (
        <>
          <MainT v={valsT(state)} close={close} go={go} />
          <OverlaysT v={valsT(state)} close={close} go={go} />
        </>
      ) : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </>
  );
}
