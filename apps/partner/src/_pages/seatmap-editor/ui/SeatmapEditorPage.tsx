// SCR-022 좌석맵 에디터(/events/[id]/seatmap). 보드 SCR-022-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.5, §3.9).
// 데스크톱(lg 이상): 도구 막대 + [계층 트리 | 캔버스 | 속성] + 요약 줄 / 태블릿: 캔버스 전체 폭 + 트리·속성 시트 /
// 휴대폰: 배치 미리보기와 좌석 요약만(편집·템플릿 자리에는 안내 카드).
// 캔버스는 보드가 그린 SVG 미리보기다. 소문자 UUID 공연이고 ?state=가 없으면 실제 에디터(Konva 편집 캔버스·저장소·Worker, ADR-0264 결정 2)를 그린다.
// 목업 공연 ID와 ?state= 상태 보기는 지금까지의 퍼블리싱 화면이다(ADR-0170).
import { requireProduction } from '@/entities/production';
import { TemplateStart } from '@peaket/ds/TemplatePicker';
import { routes } from '@/shared/config/routes';
import { SEATMAP_STATES } from '@/shared/config/states/scr022';
import { readParam, readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import { treeOf } from '../model/tree';
import { viewOf, type PropsView } from '../model/view';
import { CanvasPanel } from './CanvasPanel';
import { MODAL, SeatmapDialogs } from './Dialogs';
import { DismissBanner } from './EditorChrome';
import { EditorWorkspace } from './EditorWorkspace';
import { HierarchyTree } from './HierarchyTree';
import { LiveSeatmapPage } from './live/LiveSeatmapPage';
import { MobileSeatmap } from './MobileSeatmap';
import { PropsPanel } from './PropsPanel';
import { SummaryCard } from './SummaryCard';

const PANEL_NAME = { 1: '배치 그리기', 2: '좌석 채우기', 3: '좌석 다듬기', 4: '미리보기' } as const;

/** 태블릿 속성 시트 단추 이름: ① 구역 속성 · ② 좌석 채우기 · ③ 좌석 속성(보드 SCR-022-t) */
function sheetLabel(step: 1 | 2 | 3 | 4): string | null {
  return step === 1 ? '구역 속성' : step === 2 ? '좌석 채우기' : step === 3 ? '좌석 속성' : null;
}

/** 실제 공연 ID(소문자 UUID). 목업 ID(evt-…)는 퍼블리싱 화면으로 본다 */
const PRODUCTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function SeatmapEditorPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const sp = await searchParams;
  if (readParam(sp, 'state') === undefined && PRODUCTION_ID.test(id)) return <LiveSeatmapPage productionId={id} />;
  const pv = readPreview(sp, SEATMAP_STATES, '배치 그리기');
  const production = requireProduction(id);
  const v = viewOf(pv.state);
  const label = sheetLabel(v.step);
  // 태블릿 시트에 넣을 속성: 가져오기 진행·검증 실패(idle)와 미리보기(prices)는 시트 단추가 없다
  const sheetView: PropsView | null = label && v.props !== 'idle' && v.props !== 'prices' ? v.props : null;

  return (
    <>
      <EventContextHeader
        production={production}
        current="seatmap"
        badges={v.isDraft ? <span className="badge">초안</span> : <span className="badge badge-success">판매 승인됨</span>}
      />

      {/* 휴대폰: 미리보기와 요약만 */}
      <div className="col gap-4 md:hidden">
        <MobileSeatmap v={v} isW1={pv.state === 'W1 수량 미달'} isW3={pv.state === 'W3 온라인 판매 없음'} />
      </div>

      {/* 태블릿·데스크톱: 편집 */}
      <div className="col gap-4 max-md:hidden lg:gap-5" style={{ flex: 1 }}>
        {v.showStartBanner ? (
          <DismissBanner>템플릿 &apos;실내 아레나 · 엔드 스테이지&apos;로 시작했습니다. 공연장 배치도와 맞게 도형과 좌석을 고치세요.</DismissBanner>
        ) : null}

        {v.isStart ? (
          <TemplateStart attrs={{ template: { 'data-modal-open': MODAL.pick, 'aria-haspopup': 'dialog' } }} />
        ) : (
          <EditorWorkspace
            step={v.step}
            zoom={v.zoom}
            dirty={v.showDirty}
            showWand={v.step === 2}
            canvasLabel={PANEL_NAME[v.step]}
            tree={<HierarchyTree nodes={treeOf(v)} idPrefix="tree" />}
            canvas={<CanvasPanel view={v.canvas} />}
            propsPanel={<PropsPanel view={v.props} size="sm" priceTiers={production.priceTiers} />}
            propsSheet={sheetView ? <PropsPanel view={sheetView} size="md" priceTiers={production.priceTiers} /> : null}
            propsSheetLabel={label}
            initialSheet={v.sheet ? 'props' : null}
          />
        )}

        <SummaryCard view={v.summary} zoneCount={v.newZone ? 7 : 6} criteriaOpen={v.showCriteria} />
      </div>

      <div className="max-md:hidden">
        <SeatmapDialogs v={v} />
      </div>

      <PreviewStateSwitcher path={routes.eventTab(id, 'seatmap')} states={SEATMAP_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}
