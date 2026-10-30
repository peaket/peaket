'use client';
// 편집 화면 틀(보드 SCR-022-d·t): 위 도구 막대 + [좌 계층 트리 | 가운데 캔버스 | 우 속성](데스크톱 lg 이상 2:7:3).
// 태블릿(md~lg)은 캔버스를 전체 폭으로 두고, 계층 트리와 속성은 도구 막대의 단추로 여는 시트(캔버스 위 오른쪽·왼쪽 서랍)로 연다(d5 §3.9).
// 시트 안의 [닫기](data-sheet-close)와 Esc로 닫는다.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Step } from '../model/view';
import { GridToggle, StepTabs } from './EditorChrome';

export interface EditorWorkspaceProps {
  step: Step;
  zoom: string;
  dirty: boolean;
  /** '② 좌석 채우기'에서 [템플릿 기본값으로 모든 구역 채우기] */
  showWand: boolean;
  tree: ReactNode;
  canvas: ReactNode;
  canvasLabel: string;
  propsPanel: ReactNode;
  /** 태블릿 속성 시트 내용과 그 단추 이름(없으면 단추 없음) */
  propsSheet: ReactNode | null;
  propsSheetLabel: string | null;
  initialSheet: 'tree' | 'props' | null;
}

type Sheet = 'tree' | 'props' | null;

const DRAWER: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  zIndex: 5,
  width: 340,
  maxWidth: '86%',
  gap: 14,
  padding: '8px 18px 18px',
};

function ImportExportSave({ className }: { className: string }) {
  return (
    <>
      <button className={`btn btn-outline btn-sm ${className}`} type="button" aria-haspopup="menu">
        <i className="ic ic-upload" aria-hidden="true" />
        가져오기
      </button>
      <button className={`btn btn-outline btn-sm ${className}`} type="button" aria-haspopup="menu">
        <i className="ic ic-download" aria-hidden="true" />
        내보내기
      </button>
      <button className={`btn btn-primary btn-sm ${className}`} type="button">
        좌석맵 저장
      </button>
    </>
  );
}

function Wand({ className }: { className: string }) {
  return (
    <button className={`btn btn-outline btn-sm ${className}`} type="button">
      <i className="ic ic-wand" aria-hidden="true" />
      템플릿 기본값으로 모든 구역 채우기
    </button>
  );
}

export function EditorWorkspace({
  step,
  zoom,
  dirty,
  showWand,
  tree,
  canvas,
  canvasLabel,
  propsPanel,
  propsSheet,
  propsSheetLabel,
  initialSheet,
}: EditorWorkspaceProps) {
  const [sheet, setSheet] = useState<Sheet>(initialSheet);
  const drawerRef = useRef<HTMLDivElement>(null);
  const toggle = (s: Exclude<Sheet, null>) => setSheet((cur) => (cur === s ? null : s));

  useEffect(() => {
    if (!sheet) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSheet(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);

  const tabletBtn = 'btn btn-outline lg:hidden';
  const tabletBtnStyle = { height: 44, padding: '0 12px' };
  const iconBtn = 'icon-btn icon-btn-sm max-lg:h-11 max-lg:w-11';

  return (
    <>
      <div className="card col" role="toolbar" aria-label="좌석맵 편집 도구" style={{ padding: '8px 10px', gap: 8 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <StepTabs current={step} />
          <span className="grow" />
          {dirty ? (
            <span className="t-sm muted max-lg:hidden" role="status">
              변경 2건 · 저장 전
            </span>
          ) : null}
          <ImportExportSave className="max-lg:hidden" />
          <button className={tabletBtn} type="button" aria-expanded={sheet === 'tree'} aria-controls="seatmap-tree-sheet" onClick={() => toggle('tree')} style={tabletBtnStyle}>
            <i className="ic ic-list" aria-hidden="true" />
            좌석 계층
          </button>
          {propsSheetLabel ? (
            <button
              className={tabletBtn}
              type="button"
              aria-expanded={sheet === 'props'}
              aria-controls="seatmap-props-sheet"
              onClick={() => toggle('props')}
              style={tabletBtnStyle}
            >
              <i className="ic ic-settings" aria-hidden="true" />
              {propsSheetLabel}
            </button>
          ) : null}
        </div>
        <div className="divider" />
        <div className="row wrap" style={{ gap: 6 }}>
          <button className={iconBtn} type="button" aria-label="실행 취소">
            <i className="ic ic-undo" aria-hidden="true" />
          </button>
          <button className={iconBtn} type="button" aria-label="다시 실행">
            <i className="ic ic-redo" aria-hidden="true" />
          </button>
          <span className="vdivider" aria-hidden="true" />
          <button className={iconBtn} type="button" aria-label="축소">
            <i className="ic ic-zoom-out" aria-hidden="true" />
          </button>
          <span className="t-sm fw-b num">
            <span className="sr-only">확대 비율 </span>
            {zoom}
          </span>
          <button className={iconBtn} type="button" aria-label="확대">
            <i className="ic ic-zoom-in" aria-hidden="true" />
          </button>
          <span className="vdivider" aria-hidden="true" />
          <GridToggle />
          <span className="grow" />
          {showWand ? <Wand className="max-lg:hidden" /> : null}
          {dirty ? (
            <span className="t-sm muted lg:hidden" role="status">
              변경 2건 · 저장 전
            </span>
          ) : null}
        </div>
        <div className="row wrap lg:hidden" style={{ gap: 6 }}>
          {showWand ? <Wand className="max-lg:min-h-11" /> : null}
          <span className="grow" />
          <ImportExportSave className="max-lg:min-h-11" />
        </div>
      </div>

      <div className="grid gap-4 lg:[grid-template-columns:minmax(0,2fr)_minmax(0,7fr)_minmax(0,3fr)]" style={{ flex: 1, alignItems: 'stretch' }}>
        <section className="card col max-lg:hidden" style={{ padding: '12px 8px', gap: 10, minWidth: 0 }} aria-labelledby="h-tree">
          <div className="col" style={{ gap: 2, padding: '0 4px' }}>
            <h2 className="t-md fw-b" id="h-tree">
              좌석 계층
            </h2>
            <span className="t-xs muted">키보드로도 편집합니다</span>
          </div>
          <div style={{ overflowX: 'auto' }}>{tree}</div>
        </section>

        <section
          className="card col max-lg:min-h-[640px] max-lg:gap-3 max-lg:p-4"
          id="canvas-panel"
          role="tabpanel"
          aria-label={canvasLabel}
          style={{ padding: 14, gap: 10, minWidth: 0, position: 'relative', overflow: 'hidden' }}
        >
          {canvas}
          {sheet === 'props' && propsSheet ? (
            <div
              ref={drawerRef}
              id="seatmap-props-sheet"
              className="drawer lg:hidden"
              role="dialog"
              aria-labelledby="md-h-props"
              style={{ ...DRAWER, right: 0, borderLeft: '1px solid var(--border)' }}
              onClick={(e) => {
                if ((e.target as Element).closest('[data-sheet-close]')) setSheet(null);
              }}
            >
              {propsSheet}
            </div>
          ) : null}
          {sheet === 'tree' ? (
            <div
              id="seatmap-tree-sheet"
              className="drawer lg:hidden"
              role="dialog"
              aria-labelledby="h-tree-sheet"
              style={{ ...DRAWER, left: 0, borderRight: '1px solid var(--border)' }}
            >
              <div className="drawer-head" style={{ padding: '4px 0 10px 0', marginBottom: 0 }}>
                <div className="col grow" style={{ gap: 2 }}>
                  <h2 className="t-lg" id="h-tree-sheet">
                    좌석 계층
                  </h2>
                  <span className="t-sm muted">키보드로도 편집합니다</span>
                </div>
                <button className="icon-btn" type="button" aria-label="좌석 계층 시트 닫기" onClick={() => setSheet(null)}>
                  <i className="ic ic-close" aria-hidden="true" />
                </button>
              </div>
              {tree}
            </div>
          ) : null}
        </section>

        <section className="card col max-lg:hidden" style={{ padding: '14px 12px', gap: 12, minWidth: 0 }} aria-labelledby="sm-h-props">
          {propsPanel}
        </section>
      </div>
    </>
  );
}
