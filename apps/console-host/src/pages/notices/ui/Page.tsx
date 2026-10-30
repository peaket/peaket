// SCR-068 공지 관리(/notices, d5 §7.16). 홈 구성(배너·테마 줄 게시)을 포함한다. 보드 SCR-068-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 operator 민호의 화면이다. 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12.
// 역할(d5 §3.3): viewer는 홈 구성 읽기(처음 탭을 홈 구성으로, 버튼은 비활성), operator는 작성·발송과 홈 구성 게시, commander는 템플릿 승인과 홈 구성 게시, CS 두 역할은 메뉴에 없음.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, NoAccess, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, valsT } from './board-t';

const TITLE = '공지 관리';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'read', operator: 'act', commander: 'act', cs_agent: 'none', cs_lead: 'none' };
const ROLE_STATE: Partial<Record<ConsoleRole, State>> = { viewer: '홈 구성' };

export function Page() {
  const chosen = useChosenRole();
  const { state, layout, close, go } = useBoardPage(TITLE, STATES, (chosen && ROLE_STATE[chosen]) || DEFAULT);
  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE.operator }),
    },
    [state, chosen],
  );
  if (chosen && ACCESS[chosen] === 'none') return <NoAccess title={TITLE} role={chosen} who="viewer(홈 구성 읽기)·operator·commander" />;
  return (
    <ReadOnlyScope on={!!chosen && ACCESS[chosen] === 'read'} role={chosen ?? 'operator'} who="operator·commander">
      {layout === 'desktop' ? <MainD v={valsD(state)} close={close} go={go} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} go={go} /> : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={STATES} current={state} />
    </ReadOnlyScope>
  );
}
