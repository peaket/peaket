// SCR-032 법정 조치(/compliance, d5 §7.5). 보드 SCR-032-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 탭(통보·보안 사고·접속기록 점검)은 그 탭의 대표 상태로 옮긴다(법정 조치 탭은 주소에 담는다, docs/frontend.md §2.7).
// 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 보안 사고 상태면 SEV1 1 · 데모 환경 상태면 환경 배지 '데모 환경'.
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost } from '@/features/preview-host';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 휴대폰 보드에는 노출 차단·해시 불일치·철회 복원이 없다 */
const GAPS: BoardGaps<State> = {
  phone: {
    '노출 차단 확인': '통보',
    '자료 요청 · 해시 불일치': '자료 요청 · 제출 기록',
    '통보 철회 복원': '통보',
  },
};

export function Page() {
  const { state, boardStates, layout, close, go } = useBoardPage('법정 조치', STATES, DEFAULT, GAPS);
  const vd = valsD(state);
  const demo = vd.envLbl === '데모 환경';
  usePreviewHost(
    {
      env: demo ? { label: '데모 환경', short: '데모' } : { label: '운영 환경', short: '운영' },
      scope: { stage: 'T=0' },
      control: { kind: 'paused', remaining: '13:12' },
      alerts: vd.isIncident ? { sev1: 1, sev2: 1, sev3: 4 } : { sev1: 0, sev2: 1, sev3: 4 },
      clock: '20:04:12 KST',
    },
    [state],
  );
  const vt = layout === 'tablet' ? valsT(state) : null;
  return (
    <>
      {layout === 'desktop' ? <MainD v={vd} close={close} go={go} /> : null}
      {vt ? (
        <>
          <MainT v={vt} close={close} go={go} />
          <OverlaysT v={vt} close={close} go={go} />
        </>
      ) : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </>
  );
}
