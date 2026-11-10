'use client';
// 위 도구 막대(d5 §6.5): 네 단계 탭 · 되돌리기·다시 하기 · 확대·축소·전체 보기 · 격자 맞춤 · ① 도구(선택·무대·사각형·다각형·부채꼴·곡선 띠) ·
// 가져오기·내보내기(JSON·CSV·SVG) · '변경 n건 · 저장 전'(role="status") · [좌석맵 저장]. 잠긴 배치본은 도형·좌석 도구를 끈다.
// 저장 요청이 오가는 동안은 되돌리기·다시 하기·가져오기·다듬기를 끈다(ADR-0264 결정 30).
import { useState } from 'react';
import { useStore } from 'zustand';
import type { ExportFormat } from '../../model/export';
import type { EditorStore, Step, Tool } from '../../model/store';

const STEPS: readonly { step: Step; num?: string; label: string }[] = [
  { step: 1, num: '①', label: '배치 그리기' },
  { step: 2, num: '②', label: '좌석 채우기' },
  { step: 3, num: '③', label: '좌석 다듬기' },
  { step: 4, label: '미리보기' },
];

const EXPORT_LABEL: Record<ExportFormat, string> = { JSON: 'JSON으로 내보내기', CSV: 'CSV로 내보내기', SVG: 'SVG로 내보내기' };

const TOOLS: readonly { tool: Tool; label: string; icon: string }[] = [
  { tool: 'select', label: '선택', icon: 'ic-cursor' },
  { tool: 'stage', label: '무대', icon: 'ic-rect' },
  { tool: 'rect', label: '사각형 구역', icon: 'ic-rect' },
  { tool: 'polygon', label: '다각형 구역', icon: 'ic-polygon' },
  { tool: 'sector', label: '부채꼴 구역', icon: 'ic-sector' },
  { tool: 'arcband', label: '곡선 띠 구역', icon: 'ic-arcband' },
];

export interface ToolbarProps {
  store: EditorStore;
  scale: number;
  saveLocked: boolean;
  savedAt: string | null;
  onZoom: (f: number) => void;
  onFit: () => void;
  onSave: () => void;
  onImport: () => void;
  onExport: (f: ExportFormat) => void;
}

export function Toolbar({ store, scale, saveLocked, savedAt, onZoom, onFit, onSave, onImport, onExport }: ToolbarProps) {
  const saving = useStore(store, (s) => s.saving);
  const step = useStore(store, (s) => s.step);
  const tool = useStore(store, (s) => s.tool);
  const grid = useStore(store, (s) => s.grid);
  const changes = useStore(store, (s) => s.changes);
  const canUndo = useStore(store, (s) => s.past.length > 0);
  const canRedo = useStore(store, (s) => s.future.length > 0);
  const locked = useStore(store, (s) => s.locked);
  const [menu, setMenu] = useState(false);
  const s = () => store.getState();
  return (
    <div className="card col" role="toolbar" aria-label="좌석맵 편집 도구" style={{ padding: '8px 10px', gap: 8 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg" role="tablist" aria-label="편집 단계">
          {STEPS.map((t) => (
            <button key={t.step} className={t.step === step ? 'seg-item is-active' : 'seg-item'} type="button" role="tab" aria-selected={t.step === step} aria-controls="canvas-panel" onClick={() => s().setStep(t.step)}>
              {t.num ? (
                <>
                  <span aria-hidden="true">{t.num}</span>
                  <span className="sr-only">{t.step}단계 </span>
                </>
              ) : null}
              {t.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="t-sm muted" role="status" aria-live="polite">
          {saving ? '저장 중입니다' : changes > 0 ? `변경 ${changes.toLocaleString('ko-KR')}건 · 저장 전` : savedAt ? `${savedAt}에 저장함` : '변경 없음'}
        </span>
        <button className="btn btn-outline btn-sm" type="button" onClick={onImport} disabled={locked || saving}>
          <i className="ic ic-upload" aria-hidden="true" />
          가져오기
        </button>
        <div style={{ position: 'relative' }}>
          <button className="btn btn-outline btn-sm" type="button" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            <i className="ic ic-download" aria-hidden="true" />
            내보내기
          </button>
          {menu ? (
            <div className="card col" role="menu" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, padding: 6, gap: 4, minWidth: 180 }}>
              {(['JSON', 'CSV', 'SVG'] as const).map((f) => (
                <button key={f} className="btn btn-text btn-sm" type="button" role="menuitem" onClick={() => { setMenu(false); onExport(f); }}>
                  {EXPORT_LABEL[f]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button className="btn btn-primary btn-sm" type="button" disabled={saving || saveLocked} onClick={onSave}>
          좌석맵 저장
        </button>
      </div>
      <div className="divider" />
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="icon-btn icon-btn-sm" type="button" aria-label="실행 취소" disabled={!canUndo || saving} onClick={() => s().undo()}>
          <i className="ic ic-undo" aria-hidden="true" />
        </button>
        <button className="icon-btn icon-btn-sm" type="button" aria-label="다시 실행" disabled={!canRedo || saving} onClick={() => s().redo()}>
          <i className="ic ic-redo" aria-hidden="true" />
        </button>
        <span className="vdivider" aria-hidden="true" />
        <button className="icon-btn icon-btn-sm" type="button" aria-label="축소" disabled={step === 4} onClick={() => onZoom(1 / 1.2)}>
          <i className="ic ic-zoom-out" aria-hidden="true" />
        </button>
        <span className="t-sm fw-b num" data-testid="zoom">
          <span className="sr-only">확대 비율 </span>
          {`${Math.round(scale * 1000) / 10}%`}
        </span>
        <button className="icon-btn icon-btn-sm" type="button" aria-label="확대" disabled={step === 4} onClick={() => onZoom(1.2)}>
          <i className="ic ic-zoom-in" aria-hidden="true" />
        </button>
        <button className="btn btn-text btn-sm" type="button" disabled={step === 4} onClick={onFit}>
          전체 보기
        </button>
        <span className="vdivider" aria-hidden="true" />
        <button className="btn btn-outline btn-sm" type="button" aria-pressed={grid} onClick={() => s().setGrid(!grid)}>
          <i className="ic ic-grid" aria-hidden="true" />
          격자 맞춤
        </button>
        {step === 1 ? (
          <>
            <span className="vdivider" aria-hidden="true" />
            <div className="row wrap" role="group" aria-label="그리기 도구" style={{ gap: 4 }}>
              {TOOLS.map((t) => (
                <button key={t.tool} className="btn btn-outline btn-sm" type="button" aria-pressed={tool === t.tool} disabled={locked && t.tool !== 'select'} onClick={() => s().setTool(t.tool)}>
                  <i className={`ic ${t.icon}`} aria-hidden="true" />
                  {t.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {step === 1 && tool === 'polygon' ? <p className="t-xs muted">캔버스를 눌러 꼭짓점을 찍고 Enter나 두 번 눌러 닫습니다. Esc는 취소입니다.</p> : null}
      {step === 1 && (tool === 'rect' || tool === 'stage') ? <p className="t-xs muted">캔버스에서 끌어 사각형을 그립니다.</p> : null}
      {step === 1 && (tool === 'sector' || tool === 'arcband') ? <p className="t-xs muted">중심이 될 자리를 누르면 기본 모양이 생기고 손잡이로 반지름·각도를 바꿉니다.</p> : null}
    </div>
  );
}

export function SelectionBar({ store, busy, onRefine, onDelete }: { store: EditorStore; busy: boolean; onRefine: (t: 'align' | 'distribute' | 'aisle' | 'renumber') => void; onDelete: () => void }) {
  const n = useStore(store, (s) => s.seatSel.size);
  const tool = useStore(store, (s) => s.tool);
  const locked = useStore(store, (s) => s.locked);
  const saving = useStore(store, (s) => s.saving);
  const off = busy || locked || saving || n === 0;
  return (
    <div className="row wrap" role="group" aria-label="고른 좌석 다듬기" style={{ gap: 6 }}>
      <span className="t-sm fw-b" role="status">{`좌석 ${n.toLocaleString('ko-KR')}석 선택`}</span>
      <span className="t-xs muted">옮기기: 끌기·화살표 10cm·Shift+화살표 1m</span>
      <button className="btn btn-outline btn-sm" type="button" disabled={off} onClick={() => onRefine('align')}>
        줄 맞추기
      </button>
      <button className="btn btn-outline btn-sm" type="button" disabled={off} onClick={() => onRefine('distribute')}>
        간격 고르게
      </button>
      <button className="btn btn-outline btn-sm" type="button" disabled={off} onClick={() => onRefine('aisle')}>
        통로 만들기
      </button>
      <button className="btn btn-outline btn-sm" type="button" disabled={off} onClick={onDelete}>
        지우기
      </button>
      <button className="btn btn-outline btn-sm" type="button" aria-pressed={tool === 'insertSeat'} disabled={locked || saving} onClick={() => store.getState().setTool(tool === 'insertSeat' ? 'select' : 'insertSeat')}>
        좌석 넣기
      </button>
      <button className="btn btn-outline btn-sm" type="button" disabled={off} onClick={() => onRefine('renumber')}>
        번호 다시 매기기
      </button>
    </div>
  );
}
