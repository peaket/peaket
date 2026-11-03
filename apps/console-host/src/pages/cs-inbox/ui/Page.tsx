// SCR-045 CS 처리함(/cs/inbox, d5 §7.6). 보드 SCR-045-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 cs_agent 다은의 화면이고, 정산 이의·소명은 cs_lead 준, 'operator 보기'는 operator 민호의 화면이다(보드 머리 분기).
// 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12 · 내 승인 대기(보드 값). 목록의 건을 누르면 그 건의 상태로 옮긴다.
// 역할(d5 §3.3): viewer는 메뉴에 없음(주소로 열면 d5 상태 표의 안내, 'viewer 주소로 열기'), operator·commander는 조회와 지급·대사·KYC 정산 건 처리('operator 보기'), CS 두 역할은 처리.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';
import { ViewerNotice } from './ViewerNotice';

const TITLE = 'CS 처리함';
const ROLE_STATE: Partial<Record<ConsoleRole, State>> = { viewer: 'viewer 주소로 열기', operator: 'operator 보기', commander: 'operator 보기' };

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 열람 사유 입력·이의 인정이 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '열람 사유 입력': null,
    '정산 이의 · 이의 인정': '정산 이의',
  },
};

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, (chosen && ROLE_STATE[chosen]) || DEFAULT, GAPS);
  const vd = valsD(state);
  const isViewer = state === 'viewer 주소로 열기';
  const who: ConsoleRole = isViewer ? 'viewer' : vd.asOp ? 'operator' : vd.asLead ? 'cs_lead' : 'cs_agent';
  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      commands: { myApprovals: isViewer ? 0 : Number(vd.myAppr) },
      ...(chosen ? {} : { session: BOARD_PEOPLE[who] }),
    },
    [state, chosen],
  );
  if (isViewer) {
    return (
      <>
        <ViewerNotice />
        <PreviewSwitcher states={boardStates} current={state} />
      </>
    );
  }
  return (
    <>
      {layout === 'desktop' ? (
        <>
          <MainD v={vd} close={close} go={go} />
          <OverlaysD v={vd} close={close} go={go} />
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
