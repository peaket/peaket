// SCR-029 중앙 관제 대시보드(/dashboard?event=&tab=, d5 §7.2). 보드 SCR-029-d(데스크톱 xl 4열)·lg(1280~1439 3열)·t(태블릿 2열)·m(휴대폰 접힌 목록)을 배치마다 옮겼다.
// 데스크톱의 T=0·판매 중 탭 위젯 일부는 원격 위젯 패키지(@peaket/widget-queue·purchase)로 그리고, 경보 패널은 ds AlertPanel이다.
// 위 상태 바(단계·자동 제어·자동 조치·SEV·시계·역할)는 보드의 머리 분기대로 상태마다 호스트 값을 덮어쓴다.
import { useMemo, useState, type CSSProperties } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { previewHref } from '@peaket/ds/Preview';
import { OPERATORS } from '@/entities/operator';
import { useBoardPage } from '@/shared/lib/board';
import { useIsXl } from '@/shared/lib/layout';
import { usePreviewKeep } from '@/shared/lib/preview';
import { useHost, usePreviewHost, type HostPatch } from '@/features/preview-host';
import { useMainStyle } from '@/shared/model/shell';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES, TAB_STATE, type State } from '../states';
import { MainD, OverlaysD, valsD } from './board-d';
import { MainM, OverlaysM, valsM } from './board-m';
import { MainT, OverlaysT, valsT } from './board-t';
import type { DashCtx, TabKey } from './ctx';

/** 보드에 없고 d5 상태 표에만 있는 상태는 판매 중 탭을 바탕으로 그린다 */
const EXTRA_BASE: Partial<Record<State, State>> = {
  '위젯 로딩': '판매 중',
  '위젯 오류': '판매 중',
  '원격 위젯 적재 실패': '판매 중',
  '자동 조치 최근 풀림': '판매 중',
};

type Flags = ReturnType<typeof valsD>;

/** 보드 머리(BarD)의 분기를 호스트 덮어쓰기로 옮긴다 */
function shellPatch(f: Flags): HostPatch {
  const stage = f.stageT0 ? 'T=0' : f.isT30 ? 'T-30분 점검' : f.isAfter ? '종료 후' : f.isEntry ? '입장(공연 당일)' : undefined;
  const control: HostPatch['control'] = f.isNoInput
    ? { kind: 'no-input' }
    : f.raiseStop
      ? { kind: 'raise-stopped' }
      : f.autoPause
        ? { kind: 'paused', remaining: '13:12' }
        : f.isEmpty
          ? null // 활성 회차가 없으면 보드 머리에 자동 제어 표시가 없다
          : { kind: 'ok' };
  const alerts = f.sevSupp
    ? { sev1: 1, sev2: 1, sev3: 4, note: '같은 여정의 SEV2 1건은 SEV1 아래에 접혀 있습니다' }
    : f.sevBud || f.sevB || f.isNoInput
      ? { sev1: 0, sev2: 2, sev3: 4 }
      : f.sevEmpty
        ? { sev1: 0, sev2: 0, sev3: 4 }
        : f.isAfter
          ? { sev1: 0, sev2: 0, sev3: 3 }
          : f.isEntry
            ? { sev1: 0, sev2: 1, sev3: 1 }
            : { sev1: 0, sev2: 1, sev3: 4 };
  const clock = f.stageT0
    ? '20:04:12 KST'
    : f.isT30
      ? '19:32:40 KST'
      : f.isAfter
        ? '10/15(목) 10:20:05 KST'
        : f.isEntry
          ? '10/25(일) 17:12:30 KST'
          : '10/16(금) 11:05:30 KST';
  const patch: HostPatch = {
    scope: f.isEmpty ? { event: null, stage: undefined } : { stage },
    control,
    autoActions: f.isAuto ? { count: 3, needsHuman: true } : f.isBudget ? { count: 1, needsHuman: true } : { count: 0, needsHuman: false },
    alerts: { note: undefined, ...alerts },
    clock,
  };
  if (f.isViewer) patch.session = { ...OPERATORS.viewer };
  return patch;
}

export function Page() {
  const [params] = useSearchParams();
  const { pathname, hash } = useLocation();
  // ?state=가 없으면 ?tab=의 대표 상태, 위 상태 바 '자동 조치 n'(#w-auto)로 왔으면 걸린 자동 조치 상태(목업)
  const tab = params.get('tab') as TabKey | null;
  const fallback: State = hash === '#w-auto' ? '자동 조치 걸림' : tab && TAB_STATE[tab] ? TAB_STATE[tab] : DEFAULT;
  const { state, layout } = useBoardPage('중앙 관제 대시보드', STATES, fallback);
  // 보드가 열린 채로 그린 대화상자(T-30분 점검의 Go/No-Go 판정, 버짓 100% 소진의 Degraded 후보)는 닫으면 그 상태의 탭 내용만 남긴다
  const [dismissed, setDismissed] = useState<string | null>(null);
  const close = () => setDismissed(state);
  const showOverlays = dismissed !== state;
  const isXl = useIsXl();
  const keep = usePreviewKeep();
  const keepKey = JSON.stringify(keep);
  const host = useHost();
  const roleViewer = host.session.role === 'viewer';

  // 데스크톱·태블릿 보드에는 '메뉴 열림'이, 휴대폰 보드에는 '접은 위젯'이 없다(휴대폰은 처음부터 접힌 목록이다)
  const base: State =
    EXTRA_BASE[state] ?? (state === '메뉴 열림' && layout !== 'phone' ? 'T=0' : state === '접은 위젯' && layout === 'phone' ? '판매 중' : state);
  const recentReleased = state === '자동 조치 최근 풀림';
  // 휴대폰 '메뉴 열림'은 T=0 탭 위에 서랍을 연 그림이라 셸 값은 T=0 것을 쓴다
  const flagsD = valsD(base === '메뉴 열림' ? 'T=0' : base);
  usePreviewHost(shellPatch(flagsD), [state]);
  useMainStyle(layout === 'phone' ? undefined : { gap: 12 }, `dashboard-${layout}`);

  const ctx: DashCtx = useMemo(
    () => ({
      tabHref: (t: TabKey) => previewHref(pathname, TAB_STATE[t], { ...(JSON.parse(keepKey) as Record<string, string | undefined>), tab: t }),
      slot: state === '위젯 로딩' ? 'loading' : state === '위젯 오류' ? 'error' : state === '원격 위젯 적재 실패' ? 'remote-fail' : 'normal',
      recentReleased,
    }),
    [pathname, keepKey, state, recentReleased],
  );

  // ?role=viewer로 볼 때도 판정·명령·결정 기록 버튼을 숨긴다(보드 notViewer 분기)
  const asViewer = <T extends { isViewer: boolean; notViewer: boolean }>(v: T): T => (roleViewer ? { ...v, isViewer: true, notViewer: false } : v);

  return (
    <>
      {layout === 'desktop' ? (
        <div style={{ display: 'contents', ['--dash-cols' as string]: isXl ? 4 : 3 } as CSSProperties}>
          <MainD v={asViewer(flagsD)} close={close} ctx={ctx} />
          {showOverlays && !roleViewer ? <OverlaysD v={flagsD} close={close} /> : null}
        </div>
      ) : null}
      {layout === 'tablet' ? (
        <>
          <MainT v={asViewer(valsT(base))} close={close} ctx={ctx} />
          {showOverlays && !roleViewer ? <OverlaysT v={valsT(base)} close={close} /> : null}
        </>
      ) : null}
      {layout === 'phone' ? (
        <>
          <MainM v={asViewer(valsM(base))} close={close} ctx={ctx} />
          {showOverlays && !roleViewer ? <OverlaysM v={valsM(base)} close={close} /> : null}
        </>
      ) : null}
      <PreviewSwitcher states={STATES} current={state} />
    </>
  );
}
