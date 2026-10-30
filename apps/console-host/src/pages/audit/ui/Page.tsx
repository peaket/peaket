// SCR-031 감사 로그·인시던트 리플레이(/audit, d5 §7.4). 보드 SCR-031-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 위 상태 바는 보드 값(판매 중 · 자동 제어 정상 · SEV 0/1/4 · 20:41:07)이 호스트 기본값과 같아 덮어쓰지 않는다.
// 탭(감사 로그 · 명단 다운로드 기록)과 리플레이 재생·일시정지 버튼은 그 상태로 옮긴다(퍼블리싱 동작).
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, valsT } from './board-t';

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 리플레이 재생이 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '재생 중': null,
  },
};

export function Page() {
  const { state, boardStates, layout, close, go } = useBoardPage('감사 로그·인시던트 리플레이', STATES, DEFAULT, GAPS);
  return (
    <>
      {layout === 'desktop' ? <MainD v={valsD(state)} close={close} go={go} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} go={go} /> : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </>
  );
}
