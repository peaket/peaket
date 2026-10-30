// SCR-047 회차 취소 판정·일괄 환불(/cancellations/:requestId, d5 §7.8). 보드 SCR-047-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 commander 수진(판정)의 화면이고, 확정 직전 확인·제2 승인 대기는 operator 민호(제2 승인자)의 화면이다.
// 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12. 목업 요청 ID는 cr-lumen-r1 하나다(주소의 다른 ID도 같은 목업을 그린다).
// '제2 승인 대기'는 데스크톱·태블릿 보드에 없어 '확정 직전 확인'의 본문을 대화상자 없이 그린다(추천안).
// 역할(d5 §3.3): viewer·CS 두 역할은 읽기, operator는 제2 승인, commander는 판정·제2 승인.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, OverlaysM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

const TITLE = '회차 취소 판정·일괄 환불';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'read', operator: 'act', commander: 'act', cs_agent: 'read', cs_lead: 'read' };
const ROLE_STATE: Partial<Record<ConsoleRole, State>> = { operator: '제2 승인 대기' };
/** 휴대폰 보드의 상태 이름 */
const PHONE: Partial<Record<State, string>> = { 판정: '판정 대기', '일괄 환불 진행': '일괄 환불 진행 중', '반려·연기 처리': '판정 대기' };

export function Page() {
  const chosen = useChosenRole();
  const roleDef = chosen ? ROLE_STATE[chosen] : undefined;
  const { state, layout, close, go } = useBoardPage(TITLE, STATES, roleDef ?? DEFAULT);
  const second = state === '제2 승인 대기' || state === '확정 직전 확인';
  usePreviewHost(
    {
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      clock: '20:04:12 KST',
      ...(chosen ? {} : { session: BOARD_PEOPLE[second ? 'operator' : 'commander'] }),
    },
    [state, chosen],
  );
  // 데스크톱·태블릿: 제2 승인 대기 = 확정 직전 확인의 본문(대화상자 없음)
  const big = state === '제2 승인 대기' ? '확정 직전 확인' : state;
  const showDialog = state !== '제2 승인 대기';
  const vm = valsM(PHONE[state] ?? state);
  return (
    <ReadOnlyScope on={!!chosen && ACCESS[chosen] === 'read'} role={chosen ?? 'commander'} who="operator(제2 승인)·commander(판정·제2 승인)">
      {layout === 'desktop' ? (
        <>
          <MainD v={valsD(big)} close={close} go={go} />
          {showDialog ? <OverlaysD v={valsD(big)} close={close} go={go} /> : null}
        </>
      ) : null}
      {layout === 'tablet' ? (
        <>
          <MainT v={valsT(big)} close={close} go={go} />
          {showDialog ? <OverlaysT v={valsT(big)} close={close} go={go} /> : null}
        </>
      ) : null}
      {layout === 'phone' ? (
        <>
          <MainM v={vm} close={close} go={go} />
          <OverlaysM v={vm} close={close} go={go} />
        </>
      ) : null}
      <PreviewSwitcher states={STATES} current={state} />
    </ReadOnlyScope>
  );
}
