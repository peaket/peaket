'use client';
// 미리보기(d5 §6.5 '미리보기', FE-T38 ④): 편집 문서를 팬 좌석맵 파일 모양(SeatMapColumns)으로 바꿔 decodeLayout을 지난 값을
// 팬 좌석맵 패키지의 그리기 엔진(SeatMapEngine, 메인 스레드)에 준다. 처음에는 전체 배치이고 구역을 누르면 그 구역으로 확대한다.
// createSeatMap은 파일 주소를 받아 blob: 주소가 CSP connect-src에 걸리므로 쓰지 않는다(ADR-0264 결정 27).
// 하위 경로(./engine·./layout)로 가져온다(뿌리는 Zod를 쓰는 Worker 메시지 정의까지 싣는다, 결정 42). 파일이 풀리지 않으면 이 칸에만 알린다(결정 40).
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { SeatMapEngine } from '@peaket/seatmap/engine';
import { LayoutError, type SeatMapColumnsFile } from '@peaket/seatmap/layout';
import { previewColumns } from '../../model/doc';
import type { EditorStore } from '../../model/store';

export function Preview({ store }: { store: EditorStore }) {
  const doc = useStore(store, (s) => s.doc);
  const version = useStore(store, (s) => s.version);
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<SeatMapEngine | null>(null);
  const [level, setLevel] = useState<'overview' | 'seats' | 'empty' | 'error'>('overview');
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const file = previewColumns(doc, version) as SeatMapColumnsFile | undefined;
    if (!file) {
      setLevel('empty');
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 520;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d')!;
    const e = new SeatMapEngine({ ctx: ctx as never, width: w, height: h, dpr, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', tierNames: Object.fromEntries(doc.priceTiers.map((t) => [t.tierId, t.name])), tierRank: doc.priceTiers.map((t) => t.tierId) });
    try {
      e.load(file);
    } catch (err) {
      if (!(err instanceof LayoutError)) throw err;
      engine.current = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setLevel('error');
      return;
    }
    // 판매 상태가 없는 편집 문서라 모든 좌석을 판매 가능으로 그린다
    e.hasState = true;
    e.draw();
    engine.current = e;
    setLevel(e.level() === 'seats' ? 'seats' : 'overview');
    return () => {
      engine.current = null;
    };
  }, [doc, version]);
  const redraw = () => {
    const e = engine.current;
    if (!e) return;
    e.draw();
    setLevel(e.level() === 'seats' ? 'seats' : 'overview');
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <span className="t-sm" role="status">
          {level === 'error' ? '미리보기를 그리지 못했습니다' : level === 'empty' ? '좌석이 없어 미리보기를 그릴 수 없습니다. 좌석을 채운 뒤 보세요.' : level === 'seats' ? '확대한 좌석' : '전체 배치'}
        </span>
        <span className="grow" />
        <button className="btn btn-outline btn-sm" type="button" disabled={level === 'empty' || level === 'error'} onClick={() => { engine.current?.fitAll(); redraw(); }}>
          전체 보기
        </button>
      </div>
      <canvas
        ref={ref}
        aria-label="좌석맵 미리보기. 구역을 누르면 그 구역으로 확대합니다"
        role="img"
        style={{ width: '100%', height: 520, borderRadius: 8, background: 'var(--bg-subtle, #f8fafc)' }}
        onClick={(ev) => {
          const e = engine.current;
          if (!e) return;
          const r = ev.currentTarget.getBoundingClientRect();
          const s = e.sectionAt(ev.clientX - r.left, ev.clientY - r.top);
          if (s >= 0) {
            e.focusSection(s);
            redraw();
          }
        }}
        onWheel={(ev) => {
          const e = engine.current;
          if (!e) return;
          const r = ev.currentTarget.getBoundingClientRect();
          e.zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX - r.left, ev.clientY - r.top);
          redraw();
        }}
      />
    </div>
  );
}
