// SCR-049 정산 지급(/settlements, d5 §7.10). 보드 SCR-049-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 operator 민호의 화면이고, 'viewer 보기'는 viewer 서연, 'CS 담당자'는 cs_lead 준의 화면이다.
// 위 상태 바: 단계 종료 후 · 자동 제어 정상 · 11:42:05 · 내 승인 대기(operator 1 · viewer 0 · CS 2).
// 역할(d5 §3.3): viewer는 읽기('viewer 보기'), operator는 확인 요청·실행 기록, commander는 승인, CS 두 역할은 메뉴에 없음('CS 담당자' 안내).
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

const TITLE = '정산 지급';
/** ?role=로 열면 보드의 그 역할 상태를 처음 값으로 */
const ROLE_STATE: Partial<Record<ConsoleRole, State>> = { viewer: 'viewer 보기', cs_agent: 'CS 담당자', cs_lead: 'CS 담당자' };

function boardRole(s: State): ConsoleRole {
  return s === 'viewer 보기' ? 'viewer' : s === 'CS 담당자' ? 'cs_lead' : 'operator';
}

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 기록 시도·잔액 입력·이미 요청이 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '승인 전 기록 시도': null,
    '포트원 잔액 입력': '잔액 부족',
    '이미 요청': null,
  },
};

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, (chosen && ROLE_STATE[chosen]) || DEFAULT, GAPS);
  const who = boardRole(state);
  usePreviewHost(
    {
      scope: { stage: '종료 후' },
      control: { kind: 'ok' },
      clock: '11:42:05 KST',
      commands: { myApprovals: who === 'cs_lead' ? 2 : who === 'viewer' ? 0 : 1 },
      ...(chosen ? {} : { session: BOARD_PEOPLE[who] }),
    },
    [state, chosen],
  );
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
