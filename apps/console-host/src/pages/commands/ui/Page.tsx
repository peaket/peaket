// SCR-030 운영 명령(/commands, d5 §7.3). 보드 SCR-030-d(데스크톱)·t(태블릿)·m(휴대폰)을 배치마다 옮겼다.
// 명령 카드(CMP-036)·2인 승인 단계(CMP-037)·드라이런 미리보기(CMP-038)는 보드 마크업 그대로다(ds 부품으로 뽑는 일은 BAS-180).
// 위 상태 바는 보드 머리 분기대로 바꾼다: 단계 T=0 · 자동 제어(일시정지 13:12 / 긴급 정지 / 정상) · SEV3 수 · 승인자 화면이면 민호(operator).
import { useSearchParams } from 'react-router';
import { OPERATORS } from '@/entities/operator';
import { useBoardPage, type BoardGaps } from '@/shared/lib/board';
import { usePreviewHost, type HostPatch } from '@/features/preview-host';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, type State } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, OverlaysM, valsM } from './board-m';
import { MainT, valsT } from './board-t';
import { ConnectedPage } from './ConnectedPage';

function shell(f: { autoHold: boolean; isReport: boolean; ctlOk: boolean; asMinho: boolean; sev3: number }): HostPatch {
  return {
    scope: { stage: 'T=0' },
    control: f.isReport ? { kind: 'emergency-stop' } : f.ctlOk ? { kind: 'ok' } : { kind: 'paused', remaining: '13:12' },
    alerts: { sev1: 0, sev2: 1, sev3: f.sev3 },
    clock: '20:04:12 KST',
    ...(f.asMinho ? { session: { ...OPERATORS.operator } } : {}),
  };
}

/** 배치 보드에 없는 상태 → 그 배치에서 가장 가까운 상태(null은 그 배치의 기본 상태). 데스크톱·태블릿 보드와 휴대폰 보드의 상태가 다르다(휴대폰은 두 번째 승인·확인 위주, d5 §3.9) */
const BIG: Partial<Record<State, State | null>> = {
  '두 번째 승인(민호)': '두 번째 승인자 화면',
  '재인증 시트': '패스키 확인',
  '적용 중 명령': '명령 요청 작성',
  '전파 ack': '전파 중/ack',
  '자동화 정지 확인 시트': null,
};
const GAPS: BoardGaps<State> = {
  desktop: BIG,
  tablet: BIG,
  phone: {
    '명령 요청 작성': null,
    '킬스위치 확인': null,
    '두 번째 승인자 화면': null,
    '패스키 확인 실패': '패스키 확인',
    '전파 중/ack': '전파 ack',
    '전파 지연': '전파 ack',
    '전파 실패': '전파 ack',
    '명령 3 사후 검토 보고서': '사후 검토 보고서',
  },
};

/** 실제 경로: ops-svc 명령 API에 연결한 화면. 미리보기(?state=)는 디자인 보드를 그대로 쓴다 */
export function Page() {
  const [sp] = useSearchParams();
  return __PREVIEW__ && sp.get('state') ? <BoardPage /> : <ConnectedPage />;
}

function BoardPage() {
  const { state, boardStates, layout, close } = useBoardPage('운영 명령', STATES, DEFAULT, GAPS);
  const vd = valsD(state);
  const vm = valsM(state);
  const f = layout === 'phone' ? vm : vd;
  usePreviewHost(shell(f), [state, layout]);
  return (
    <>
      {layout === 'desktop' ? <MainD v={vd} close={close} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} /> : null}
      {layout === 'phone' ? (
        <>
          <MainM v={vm} close={close} />
          <OverlaysM v={vm} close={close} />
        </>
      ) : null}
      <PreviewSwitcher states={boardStates} current={state} />
    </>
  );
}
