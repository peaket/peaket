// SCR-046 승인 업무(/cs/approvals, d5 §7.7). 보드 SCR-046-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 cs_lead 준의 화면이고, commander 재인증·패스키 상태는 commander 수진의 화면이다(보드 머리 분기).
// 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12 · 내 승인 대기(준 2 · 수진 1). 요청 목록의 카드를 누르면 그 요청 상태로 옮긴다.
// 증빙 파일은 받거나 저장하지 않는다(d5 §3.7).
// 역할(d5 §3.3): viewer는 메뉴에 없음, operator·cs_agent는 요청만(승인 버튼 비활성), commander는 2인 승인, cs_lead는 1인 승인.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, OverlaysM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

const TITLE = '승인 업무';
/** 'read'는 이 화면에서 요청만 하는 역할이다(승인 버튼을 막는다) */
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'none', operator: 'read', commander: 'act', cs_agent: 'read', cs_lead: 'act' };

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 정산서 수기 조정 요청이 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '정산서 수기 조정(이의 없음)': null,
    '수기 조정 · 지급 요청 뒤(409)': null,
  },
};

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT, GAPS);
  const vd = valsD(state);
  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      commands: { myApprovals: Number(vd.nMine) },
      ...(chosen ? {} : { session: BOARD_PEOPLE[vd.asCmd ? 'commander' : 'cs_lead'] }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="operator·commander·CS 담당자" />;
  return (
    <ReadOnlyScope
      on={!!chosen && ACCESS[chosen] === 'read'}
      role={chosen ?? 'cs_lead'}
      title="이 역할은 승인 업무를 요청만 합니다"
      who="승인 권한이 있는 역할(cs_lead 1인 승인 · commander 2인 승인)"
    >
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
      {layout === 'phone' ? (
        <>
          <MainM v={valsM(state)} close={close} go={go} />
          <OverlaysM v={valsM(state)} close={close} go={go} />
        </>
      ) : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </ReadOnlyScope>
  );
}
