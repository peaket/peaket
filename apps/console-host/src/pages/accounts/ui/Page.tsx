// SCR-064 관리 계정·세션 관리(/accounts, d5 §7.12). 보드 SCR-064-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 commander 수진의 화면이다. 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12.
// 계정 줄과 '운영자·CS'·'파트너 계정' 탭을 누르면 그 상태로 옮긴다. 재인증·패스키 대화상자는 보드 마크업 그대로다(CMP-064 admin).
// 역할(d5 §3.3): viewer·CS 두 역할은 메뉴에 없음, operator는 파트너 계정·강제 종료('파트너 계정 탭'), commander는 운영자·CS 역할과 지정.
// operator가 운영자·CS 탭을 열면 d5 상태 표 '권한 밖'대로 강제 종료를 뺀 버튼을 비활성 + 이유로 둔다.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

const TITLE = '관리 계정·세션 관리';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'none', operator: 'act', commander: 'act', cs_agent: 'none', cs_lead: 'none' };
const ROLE_STATE: Partial<Record<ConsoleRole, State>> = { operator: '파트너 계정 탭' };

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 역할 변경·초대·삭제 대화상자가 없다(d5 §3.9 휴대폰 범위) */
const GAPS: BoardGaps<State> = {
  phone: {
    '역할 변경 재인증': null,
    '역할 변경 · 패스키 확인': null,
    '역할 변경 · 패스키 확인 실패': null,
    '초대 보내기': null,
    '파트너 계정 탭 · 재초대(분실)': '파트너 계정 탭',
    'commander 계정 삭제': null,
  },
};

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, (chosen && ROLE_STATE[chosen]) || DEFAULT, GAPS);
  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.commander }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="operator(파트너 계정)·commander" />;
  const vd = valsD(state);
  return (
    <ReadOnlyScope
      on={chosen === 'operator' && vd.isOps}
      role="operator"
      title="operator는 운영자·CS 계정의 역할을 바꾸지 않습니다"
      who="commander(운영자·CS 계정), operator는 파트너 계정 탭과 세션 강제 종료"
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
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </ReadOnlyScope>
  );
}
