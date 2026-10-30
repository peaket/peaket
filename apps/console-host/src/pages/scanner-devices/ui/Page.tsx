// SCR-053 스캐너 기기 관리(/scanner-devices, d5 §7.11). 보드 SCR-053-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 operator 민호의 화면이다. 위 상태 바: 단계 입장 · 자동 제어 정상 · 시각은 상태마다 보드 값(17:12:40 · 폐기 17:13:15 · 등록 코드 18:05:10 · 만료 18:14:20).
// 등록 코드의 QR은 보드가 칸으로 그린 근사 그림 그대로다(design.md 결정 8, 실제 코드는 만들지 않는다).
// 역할(d5 §3.3): viewer는 읽기, operator·commander는 등록·폐기, CS 두 역할은 메뉴에 없음.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, OverlaysM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

const TITLE = '스캐너 기기 관리';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'read', operator: 'act', commander: 'act', cs_agent: 'none', cs_lead: 'none' };
const CLOCK: Partial<Record<State, string>> = { 폐기됨: '17:13:15 KST', '등록 코드': '18:05:10 KST', '코드 만료': '18:14:20 KST' };

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 기기 등록 코드가 없다(등록은 큰 화면에서) */
const GAPS: BoardGaps<State> = {
  phone: {
    '등록 코드': null,
    '코드 만료': null,
  },
};

export function Page() {
  const chosen = useChosenRole();
  const { state, boardStates, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT, GAPS);
  usePreviewHost(
    {
      scope: { stage: '입장' },
      control: { kind: 'ok' },
      clock: CLOCK[state] ?? '17:12:40 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.operator }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="viewer(읽기)·operator·commander" />;
  return (
    <ReadOnlyScope on={!!chosen && ACCESS[chosen] === 'read'} role={chosen ?? 'operator'} who="operator·commander">
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
