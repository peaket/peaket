// SCR-048 판매 승인(/sale-reviews/:productionId, d5 §7.9). 보드 SCR-048-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 보드는 operator 민호의 화면이고, '올리기 간격 충돌 — commander'만 commander 수진의 화면이다.
// 수요 예측 줄·[규모 올리기]·판매 중지·재개와 공연 정보 JSON 읽기 전용 미리보기는 보드 마크업 그대로다.
// 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12. 목록 탭(승인 대기·승인됨·판매 중지)은 그 탭의 대표 상태로 옮긴다.
// 역할(d5 §3.3): viewer·CS 두 역할은 읽기, operator는 승인·반려와 판매 중지·재개 요청, commander는 그 승인까지.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, useChosenRole } from '@/features/preview-host';
import { BOARD_PEOPLE, ReadOnlyScope, type Access } from '@/features/screen-access';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';
import { EmptyQueue } from './EmptyQueue';

const TITLE = '판매 승인';
const ACCESS: Record<ConsoleRole, Access> = { viewer: 'read', operator: 'act', commander: 'act', cs_agent: 'read', cs_lead: 'read' };

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 간격 충돌·올리기 닫힘·판매 중지 요청·재개 불가가 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '대형 간격 충돌': null,
    '올리기 간격 충돌 — operator': '규모 올리기 검토',
    '올리기 간격 충돌 — commander': '규모 올리기 검토',
    '규모 올리기 닫힘': '규모 올리기 검토',
    '판매 중지 요청': '판매 중지 승인 대기',
    '재개할 수 없는 회차': '판매 중지됨',
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
      ...(chosen ? {} : { session: BOARD_PEOPLE[vd.asSujin ? 'commander' : 'operator'] }),
    },
    [state, chosen],
  );
  return (
    <ReadOnlyScope on={!!chosen && ACCESS[chosen] === 'read'} role={chosen ?? 'operator'} who="operator·commander">
      {state === '빈 화면' ? <EmptyQueue /> : null}
      {state !== '빈 화면' && layout === 'desktop' ? (
        <>
          <MainD v={vd} close={close} go={go} />
          <OverlaysD v={vd} close={close} go={go} />
        </>
      ) : null}
      {state !== '빈 화면' && layout === 'tablet' ? (
        <>
          <MainT v={valsT(state)} close={close} go={go} />
          <OverlaysT v={valsT(state)} close={close} go={go} />
        </>
      ) : null}
      {state !== '빈 화면' && layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </ReadOnlyScope>
  );
}
