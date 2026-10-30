// 상태 이름(?state=) → 화면 조각. 보드 SCR-022-d·t·m의 renderVals를 한곳에 옮겼다.
import type { SEATMAP_STATES } from '@/shared/config/states/scr022';

export type SeatmapState = (typeof SEATMAP_STATES)[number];

export type Step = 1 | 2 | 3 | 4;
export type CanvasView = 'layout' | 'fill' | 'noShape' | 'refine' | 'over' | 'a1' | 'preview' | 'previewZoom' | 'out' | 'import' | 'fail';
export type PropsView = 'shape' | 'fill' | 'noShape' | 'seats' | 'over' | 'a1' | 'out' | 'prices' | 'idle';
export type TreeView = 'base' | 'refine' | 'over' | 'a1';
export type SummaryView = 'pass' | 'fill' | 'over' | 'out' | 'warn' | 'empty' | 'w1' | 'w3';
/** 태블릿에서 처음 열린 시트 */
export type TabletSheet = 'zone' | 'fill' | 'noShape' | 'seat' | null;
export type MobileView = 'start' | 'overview' | 'out' | 'zoom' | 'over' | 'warn';

export interface EditorView {
  isStart: boolean;
  dialog: 'pick' | 'setup' | 'refill' | null;
  step: Step;
  canvas: CanvasView;
  props: PropsView;
  tree: TreeView;
  summary: SummaryView;
  sheet: TabletSheet;
  mobile: MobileView;
  isDraft: boolean;
  showStartBanner: boolean;
  showDirty: boolean;
  zoom: string;
  showCriteria: boolean;
  /** 도형 없는 '새 구역'을 트리에 더한다 */
  newZone: boolean;
  /** 트리 S2구역에 '도형 밖 3석' */
  outInTree: boolean;
  /** A1구역 트리 줄을 고른 상태로(배치 그리기·좌석 채우기) */
  a1Selected: boolean;
  /** 채우기 미리보기 전후의 A1 좌석 수·총 좌석 */
  a1Count: number;
  total: string;
  /** 휠체어석 수(A1·A2 각각) */
  wcPerZone: number;
}

export function viewOf(st: SeatmapState): EditorView {
  const zoneSheet = st === '구역 속성 시트';
  const seatSheet = st === '좌석 속성 시트';
  const lay = st === '배치 그리기' || zoneSheet;
  const start = st === '시작';
  const pick = st === '템플릿 고르기';
  const tset = st === '템플릿 설정';
  const startScr = start || pick || tset;
  const fill = st === '좌석 채우기';
  const refill = st === '좌석 다시 채우기 확인';
  const fillV = fill || refill;
  const noShape = st === '구역 도형 없음';
  const refine = st === '좌석 다듬기' || seatSheet;
  const w1 = st === 'W1 수량 미달';
  const w3 = st === 'W3 온라인 판매 없음';
  const crit = st === '기준 보기 펼침';
  const refineV = refine || w1 || w3 || crit;
  const over = st === '좌석 겹침';
  const warn = st === '휠체어석 기준 경고';
  const prev = st === '미리보기';
  const prevZ = st === '미리보기 — 확대';
  const out = st === '도형 밖 좌석';
  const imp = st === '가져오기 진행';
  const fail = st === '검증 실패';
  const step2 = fillV || noShape;
  const step3 = refineV || over || warn;
  const step4 = prev || prevZ;
  const step: Step = step2 ? 2 : step3 ? 3 : step4 ? 4 : 1;

  let zoom = '100%';
  if (step2) zoom = '180%';
  if (step3) zoom = warn ? '180%' : '220%';
  if (prevZ) zoom = '320%';

  const canvas: CanvasView = fillV
    ? 'fill'
    : noShape
      ? 'noShape'
      : refineV
        ? 'refine'
        : over
          ? 'over'
          : warn
            ? 'a1'
            : prev
              ? 'preview'
              : prevZ
                ? 'previewZoom'
                : out
                  ? 'out'
                  : imp
                    ? 'import'
                    : fail
                      ? 'fail'
                      : 'layout';

  const props: PropsView = lay
    ? 'shape'
    : fillV
      ? 'fill'
      : noShape
        ? 'noShape'
        : refineV
          ? 'seats'
          : over
            ? 'over'
            : warn
              ? 'a1'
              : out
                ? 'out'
                : step4
                  ? 'prices'
                  : 'idle';

  const tree: TreeView = refineV ? 'refine' : over ? 'over' : warn ? 'a1' : 'base';

  const summary: SummaryView = startScr
    ? 'empty'
    : fillV
      ? 'fill'
      : over
        ? 'over'
        : out
          ? 'out'
          : warn
            ? 'warn'
            : w1
              ? 'w1'
              : w3
                ? 'w3'
                : 'pass';

  const mobile: MobileView = startScr ? 'start' : out ? 'out' : over ? 'over' : prevZ ? 'zoom' : warn ? 'warn' : 'overview';

  return {
    isStart: startScr,
    dialog: pick ? 'pick' : tset ? 'setup' : refill ? 'refill' : null,
    step,
    canvas,
    props,
    tree,
    summary,
    sheet: zoneSheet ? 'zone' : fillV ? 'fill' : noShape ? 'noShape' : seatSheet ? 'seat' : null,
    mobile,
    isDraft: startScr || lay || fillV || noShape || refine || over,
    showStartBanner: lay,
    showDirty: lay || step2 || step3 || out,
    zoom,
    showCriteria: crit,
    newZone: noShape,
    outInTree: out,
    a1Selected: lay || fillV,
    a1Count: fillV ? 420 : 450,
    total: fillV ? '2,370석' : '2,400석',
    wcPerZone: w1 ? 6 : 10,
  };
}
