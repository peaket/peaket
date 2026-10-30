// SCR-065 파트너사·계약 관리(/partners, d5 §7.13). 보드 SCR-065-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 operator 민호의 화면이다. 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12.
// 목록의 파트너 줄과 '계약'·'결제사 등록' 탭은 그 상태로 옮긴다(보드가 그린 두 파트너·두 탭만 있다).
// 역할(d5 §3.3): viewer는 메뉴에 없음, operator는 입력·변경 요청, commander는 입력·변경 승인(승인은 승인 업무에서), CS 두 역할은 읽기.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, valsT } from './board-t';

const TITLE = '파트너사·계약 관리';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'none', operator: 'act', commander: 'act', cs_agent: 'read', cs_lead: 'read' };

export function Page() {
  const chosen = useChosenRole();
  const { state, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT);
  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.operator }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="operator·commander" />;
  return (
    <ReadOnlyScope on={!!chosen && ACCESS[chosen] === 'read'} role={chosen ?? 'operator'} who="operator·commander">
      {layout === 'desktop' ? <MainD v={valsD(state)} close={close} go={go} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} go={go} /> : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={STATES} current={state} />
    </ReadOnlyScope>
  );
}
