// CMP-051 좌석맵 편집 캔버스(ADR-0264 결정 3, docs/frontend.md §5.6). Konva는 이 폴더에서만 가져온다(ESLint no-restricted-imports, asvs/frontend.md 15.1.4).
// Stage 하나에 Layer 넷: 격자(Shape 하나, 듣지 않음) · 배치(무대·구역 닫힌 Line, 구역 라벨 Text — 글자는 캔버스 그리기로만) ·
// 좌석(구역마다 Shape 하나가 그 구역 좌석을 한 번에 그린다, 듣지 않음. 누르기·상자·행 고르기는 격자 색인으로 찾는다) ·
// 조작(Transformer, 다각형 꼭짓점·'＋' 점, 부채꼴·곡선 띠 반지름·각도 손잡이, 안내선·치수 글자, 고르기 상자). 손잡이를 놓으면 저장소 명령 하나가 된다.
// 저장소는 React 밖에서 구독해 바뀐 구역 노드만 고친다(frontend §3.9). 계산(도형 수학·좌석 찾기)은 화면이 넘긴 host 함수가 한다.
import Konva from 'konva/lib/Core';
import { Circle } from 'konva/lib/shapes/Circle';
import { Line } from 'konva/lib/shapes/Line';
import { Rect } from 'konva/lib/shapes/Rect';
import { Text } from 'konva/lib/shapes/Text';
import { Transformer } from 'konva/lib/shapes/Transformer';
import type { Arc, EditorDoc, Pt, Shape } from '@/_pages/seatmap-editor/model/types';

/** 바퀴 한 칸의 배율 [가정], 배율 범위 [가정](ADR-0264 결정 3) */
export const WHEEL_FACTOR = 1.2;
export const SCALE_MIN = 0.02;
export const SCALE_MAX = 8;
/** 좌석 원 반지름(cm, 좌석 간격 50cm의 0.4)과 화면에서의 가장 작은 반지름(px) */
const SEAT_R = 20;
const SEAT_MIN_PX = 1.5;

export type CanvasStep = 1 | 2 | 3 | 4;
export type CanvasTool = 'select' | 'stage' | 'rect' | 'polygon' | 'sector' | 'arcband' | 'insertSeat';
export type CanvasSel = { kind: 'section'; id: string } | { kind: 'stage'; index: number } | null;

export interface CanvasState {
  doc: EditorDoc;
  rev: number;
  touched: { sections: readonly string[] | 'all'; stage: boolean };
  step: CanvasStep;
  tool: CanvasTool;
  sel: CanvasSel;
  seatSel: ReadonlySet<string>;
  grid: boolean;
  locked: boolean;
  /** 저장 요청이 오가는 중: 편집 조작을 받지 않는다(ADR-0264 결정 30) */
  saving: boolean;
  ghost: { sectionId: string; seats: readonly { x: number; y: number }[] } | null;
}

export interface RectParams {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

/** 화면(페이지 모델)이 넘기는 계산과 명령 */
export interface CanvasHost {
  getState(): CanvasState;
  subscribe(fn: (s: CanvasState, prev: CanvasState) => void): () => void;
  geo: {
    rectParams(points: readonly Pt[]): RectParams;
    isRectLike(points: readonly Pt[]): boolean;
    arcHandles(a: Arc): { outer: Pt; inner: Pt; start: Pt; end: Pt };
    dragArcHandle(a: Arc, handle: 'outer' | 'inner' | 'start' | 'end', x: number, y: number): Arc;
    arcPoints(a: Arc): Pt[];
    bbox(pts: readonly Pt[]): { minX: number; minY: number; maxX: number; maxY: number };
    centroid(pts: readonly Pt[]): Pt;
    snapBox(box: { minX: number; minY: number; maxX: number; maxY: number }, lines: { xs: number[]; ys: number[] }, threshold: number, grid: boolean): { dx: number; dy: number; guideX?: number; guideY?: number };
    guideLines(others: readonly (readonly Pt[])[]): { xs: number[]; ys: number[] };
    snapGrid(v: number): number;
    dimensionText(pts: readonly Pt[], kind: Shape['kind']): string;
    guidePx: number;
    gridCm: number;
  };
  actions: {
    select(sel: CanvasSel): void;
    /** 끌기로 옮김(세계 단위, 맞춤 반영) */
    moveShape(sel: Exclude<CanvasSel, null>, dx: number, dy: number): void;
    setRect(sel: Exclude<CanvasSel, null>, p: RectParams): void;
    setArc(sel: Exclude<CanvasSel, null>, a: Arc): void;
    moveVertex(sel: Exclude<CanvasSel, null>, i: number, x: number, y: number): void;
    insertVertex(sel: Exclude<CanvasSel, null>, edge: number): void;
    removeVertex(sel: Exclude<CanvasSel, null>, i: number): void;
    addRect(target: 'stage' | 'section', x0: number, y0: number, x1: number, y1: number): void;
    addPolygon(points: Pt[]): void;
    addArc(kind: 'SECTOR' | 'ARC_BAND', x: number, y: number): void;
    pickSeat(x: number, y: number): string | null;
    boxSeats(box: { minX: number; minY: number; maxX: number; maxY: number }): string[];
    rowSeats(seatId: string): string[];
    selectSeats(ids: string[], add: boolean): void;
    moveSeats(dx: number, dy: number): void;
    insertSeat(x: number, y: number): void;
    sectionAt(x: number, y: number): string | null;
  };
  /** 배율이 바뀔 때(도구 막대의 확대 비율) */
  onView?(scale: number): void;
}

export interface CanvasHandle {
  fit(): void;
  zoomBy(f: number): void;
  scale(): number;
  /** 세계 좌표 → 화면(컨테이너 안 px) */
  toScreen(x: number, y: number): Pt;
  destroy(): void;
}

const COLORS = {
  bg: '#ffffff',
  outside: '#f2f3f5',
  grid: '#e5e7eb',
  gridMajor: '#d1d5db',
  border: '#9ca3af',
  stage: '#cbd5e1',
  section: 'rgba(59,130,246,0.10)',
  sectionLine: '#6b7280',
  sectionSel: '#2563eb',
  seat: '#475569',
  wheel: '#0ea5e9',
  off: '#cbd5e1',
  mine: '#f97316',
  ghost: 'rgba(37,99,235,0.35)',
  guide: '#ef4444',
  handle: '#2563eb',
  text: '#111827',
};

export function mountSeatmapCanvas(el: HTMLDivElement, host: CanvasHost): CanvasHandle {
  const stage = new Konva.Stage({ container: el, width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) });
  const gridLayer = new Konva.Layer({ listening: false });
  const layoutLayer = new Konva.Layer();
  const seatLayer = new Konva.Layer({ listening: false });
  const uiLayer = new Konva.Layer();
  stage.add(gridLayer, layoutLayer, seatLayer, uiLayer);

  let st = host.getState();
  /** 구역 ID는 바깥 글자라 표의 자기 칸만 읽는다 */
  const ownSection = (id: string) => (Object.hasOwn(st.doc.sections, id) ? st.doc.sections[id] : undefined);
  /** 잠긴 배치본이거나 저장 중이면 도형·좌석을 바꾸는 조작을 받지 않는다 */
  const noEdit = () => st.locked || st.saving;
  let scale = 1;
  const world = () => stage.getRelativePointerPosition() ?? { x: 0, y: 0 };

  // ---------- 격자 층 ----------
  const grid = new Konva.Shape({
    listening: false,
    perfectDrawEnabled: false,
    sceneFunc: (con) => {
      const ctx = con._context;
      const { width, height } = st.doc.canvas;
      const s = scale;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, width, height);
      if (st.grid) {
        const pos = stage.position();
        const x0 = Math.max(0, -pos.x / s);
        const y0 = Math.max(0, -pos.y / s);
        const x1 = Math.min(width, (stage.width() - pos.x) / s);
        const y1 = Math.min(height, (stage.height() - pos.y) / s);
        const step = host.geo.gridCm * (host.geo.gridCm * s < 4 ? 10 : 1);
        ctx.lineWidth = 1 / s;
        ctx.beginPath();
        for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
        }
        for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
        }
        ctx.strokeStyle = COLORS.grid;
        ctx.stroke();
      }
      ctx.lineWidth = 2 / s;
      ctx.strokeStyle = COLORS.border;
      ctx.strokeRect(0, 0, width, height);
    },
  });
  gridLayer.add(grid);

  // ---------- 배치 층 ----------
  const stageNodes: Line[] = [];
  const sectionNodes = new Map<string, { line: Line; label: Text }>();
  const seatNodes = new Map<string, Konva.Shape>();

  const flat = (pts: readonly Pt[]) => pts.flatMap(([x, y]) => [x, y]);
  const selected = (sel: CanvasSel, kind: 'section' | 'stage', key: string | number) => sel !== null && sel.kind === kind && (kind === 'section' ? (sel as { id: string }).id === key : (sel as { index: number }).index === key);

  function shapeOfSel(sel: CanvasSel): Shape | undefined {
    if (!sel) return undefined;
    return sel.kind === 'stage' ? st.doc.stage[sel.index] : ownSection(sel.id)?.shape;
  }

  function bindShapeEvents(node: Line, selOf: () => Exclude<CanvasSel, null>) {
    node.on('mousedown touchstart', (e) => {
      if (st.step === 1 && st.tool === 'select') {
        e.cancelBubble = true;
        host.actions.select(selOf());
      } else if (st.step === 2 && selOf().kind === 'section') {
        e.cancelBubble = true;
        host.actions.select(selOf());
      }
    });
    let start: Pt = [0, 0];
    let box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let lines = { xs: [] as number[], ys: [] as number[] };
    node.on('dragstart', () => {
      const s = selOf();
      const shape = shapeOfSel(s);
      if (!shape) return;
      start = [node.x(), node.y()];
      box = host.geo.bbox(shape.points);
      const others = [...st.doc.stage.filter((_, i) => !(s.kind === 'stage' && s.index === i)).map((x) => x.points), ...st.doc.order.filter((id) => !(s.kind === 'section' && s.id === id)).map((id) => st.doc.sections[id]!.shape.points)];
      lines = host.geo.guideLines(others);
    });
    node.on('dragmove', () => {
      const dx = node.x() - start[0];
      const dy = node.y() - start[1];
      const b = { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy };
      const snap = host.geo.snapBox(b, lines, host.geo.guidePx / scale, st.grid);
      node.position({ x: start[0] + dx + snap.dx, y: start[1] + dy + snap.dy });
      drawGuides(snap.guideX, snap.guideY);
      const shape = shapeOfSel(selOf());
      if (shape) showDimension(shape.points.map(([x, y]) => [x + node.x(), y + node.y()] as Pt), shape.kind);
    });
    node.on('dragend', () => {
      const dx = Math.round(node.x());
      const dy = Math.round(node.y());
      node.position({ x: 0, y: 0 });
      clearGuides();
      if (dx !== 0 || dy !== 0) host.actions.moveShape(selOf(), dx, dy);
      else syncUi();
    });
  }

  function syncLayout(touchedIds: readonly string[] | 'all', stageTouched: boolean) {
    const doc = st.doc;
    if (stageTouched || touchedIds === 'all') {
      for (const n of stageNodes.splice(0)) n.destroy();
      doc.stage.forEach((s, i) => {
        const line = new Line({ points: flat(s.points), closed: true, fill: COLORS.stage, stroke: COLORS.sectionLine, strokeWidth: 1, strokeScaleEnabled: false, perfectDrawEnabled: false, name: 'stage' });
        bindShapeEvents(line, () => ({ kind: 'stage', index: i }));
        layoutLayer.add(line);
        stageNodes.push(line);
      });
    }
    const ids = touchedIds === 'all' ? [...new Set([...sectionNodes.keys(), ...doc.order])] : touchedIds;
    for (const id of ids) {
      const s = ownSection(id);
      const cur = sectionNodes.get(id);
      if (!s) {
        cur?.line.destroy();
        cur?.label.destroy();
        sectionNodes.delete(id);
        seatNodes.get(id)?.destroy();
        seatNodes.delete(id);
        continue;
      }
      const [cx, cy] = s.label?.x !== undefined && s.label?.y !== undefined ? [s.label.x, s.label.y] : host.geo.centroid(s.shape.points);
      if (cur) {
        cur.line.points(flat(s.shape.points));
        // 구역 이름은 캔버스 글자(fillText)로만 그린다. HTML로 해석하지 않는다(ASVS 1.1.2·3.2.2)
        cur.label.text(s.name);
        cur.label.position({ x: cx, y: cy });
      } else {
        const line = new Line({ points: flat(s.shape.points), closed: true, fill: COLORS.section, stroke: COLORS.sectionLine, strokeWidth: 1, strokeScaleEnabled: false, perfectDrawEnabled: false, name: 'section' });
        bindShapeEvents(line, () => ({ kind: 'section', id }));
        const label = new Text({ text: s.name, x: cx, y: cy, fontSize: 14, fill: COLORS.text, listening: false, perfectDrawEnabled: false });
        layoutLayer.add(line, label);
        sectionNodes.set(id, { line, label });
        const seats = new Konva.Shape({ listening: false, perfectDrawEnabled: false, sceneFunc: (con) => drawSeats(con._context, id) });
        seatLayer.add(seats);
        seatNodes.set(id, seats);
      }
    }
    // 구역 차례대로 그린다(겹치면 뒤 구역이 위)
    doc.order.forEach((id) => {
      const n = sectionNodes.get(id);
      n?.line.moveToTop();
      n?.label.moveToTop();
    });
    styleNodes();
  }

  function styleNodes() {
    const editable = st.step === 1 && st.tool === 'select' && !noEdit();
    stageNodes.forEach((n, i) => {
      n.stroke(selected(st.sel, 'stage', i) ? COLORS.sectionSel : COLORS.sectionLine);
      n.strokeWidth(selected(st.sel, 'stage', i) ? 2 : 1);
      n.listening(st.step === 1);
      n.draggable(editable && selected(st.sel, 'stage', i) && !isRect(st.doc.stage[i]));
    });
    for (const [id, n] of sectionNodes) {
      const on = selected(st.sel, 'section', id);
      n.line.stroke(on ? COLORS.sectionSel : COLORS.sectionLine);
      n.line.strokeWidth(on ? 2 : 1);
      n.line.listening(st.step === 1 || st.step === 2);
      n.line.draggable(editable && on && !isRect(ownSection(id)?.shape));
      n.label.fontSize(14 / scale);
    }
  }

  const isRect = (s: Shape | undefined) => s !== undefined && s.kind === 'RECT' && host.geo.isRectLike(s.points);

  // ---------- 좌석 층 ----------
  let seatDrag: Pt | null = null;
  function drawSeats(ctx: CanvasRenderingContext2D, id: string) {
    const s = ownSection(id);
    if (!s) return;
    const r = Math.max(SEAT_R, SEAT_MIN_PX / scale);
    const small = r * scale < 3;
    const groups: Record<string, Pt[]> = { seat: [], wheel: [], off: [], mine: [] };
    for (const x of s.seats) {
      const mine = st.seatSel.has(x.seatId);
      const k = mine ? 'mine' : x.unavailable ? 'off' : x.wheelchair ? 'wheel' : 'seat';
      groups[k]!.push(mine && seatDrag ? [x.x + seatDrag[0], x.y + seatDrag[1]] : [x.x, x.y]);
    }
    for (const [k, pts] of Object.entries(groups)) {
      if (pts.length === 0) continue;
      ctx.beginPath();
      for (const [x, y] of pts) {
        if (small) ctx.rect(x - r, y - r, 2 * r, 2 * r);
        else {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = COLORS[k as keyof typeof COLORS];
      ctx.fill();
    }
    if (st.ghost?.sectionId === id) {
      ctx.beginPath();
      for (const p of st.ghost.seats) {
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = COLORS.ghost;
      ctx.fill();
    }
  }

  // ---------- 조작 층 ----------
  const guideX = new Line({ points: [], stroke: COLORS.guide, strokeWidth: 1, strokeScaleEnabled: false, dash: [4, 4], listening: false, visible: false });
  const guideY = new Line({ points: [], stroke: COLORS.guide, strokeWidth: 1, strokeScaleEnabled: false, dash: [4, 4], listening: false, visible: false });
  const dim = new Text({ text: '', fontSize: 12, fill: COLORS.text, listening: false, visible: false });
  const boxRect = new Rect({ stroke: COLORS.handle, strokeWidth: 1, strokeScaleEnabled: false, dash: [4, 3], fill: 'rgba(37,99,235,0.08)', listening: false, visible: false });
  const draftLine = new Line({ points: [], stroke: COLORS.handle, strokeWidth: 2, strokeScaleEnabled: false, dash: [6, 4], listening: false, visible: false });
  const transformer = new Transformer({ rotateEnabled: true, keepRatio: false, flipEnabled: false, ignoreStroke: true, anchorSize: 10, rotationSnaps: [0, 90, 180, 270], rotationSnapTolerance: 3 });
  const rectProxy = new Rect({ fill: 'rgba(0,0,0,0.001)', stroke: COLORS.sectionSel, strokeWidth: 0, draggable: true, visible: false, name: 'rect-proxy' });
  const handles = new Konva.Group();
  uiLayer.add(guideX, guideY, rectProxy, transformer, handles, dim, boxRect, draftLine);

  function drawGuides(gx?: number, gy?: number) {
    const { width, height } = st.doc.canvas;
    guideX.visible(gx !== undefined);
    guideY.visible(gy !== undefined);
    if (gx !== undefined) guideX.points([gx, 0, gx, height]);
    if (gy !== undefined) guideY.points([0, gy, width, gy]);
    uiLayer.batchDraw();
  }
  function clearGuides() {
    guideX.visible(false);
    guideY.visible(false);
    dim.visible(false);
  }
  function showDimension(pts: readonly Pt[], kind: Shape['kind']) {
    const b = host.geo.bbox(pts);
    dim.text(host.geo.dimensionText(pts, kind));
    dim.fontSize(12 / scale);
    dim.position({ x: b.minX, y: b.minY - 18 / scale });
    dim.visible(true);
  }

  let rectSel: Exclude<CanvasSel, null> | null = null;
  rectProxy.on('dragmove', () => {
    const shape = shapeOfSel(rectSel);
    if (!shape || !rectSel) return;
    const p = host.geo.rectParams(shape.points);
    const dx = rectProxy.x() - p.x;
    const dy = rectProxy.y() - p.y;
    const b = host.geo.bbox(shape.points);
    const others = [...st.doc.stage.filter((_, i) => !(rectSel!.kind === 'stage' && rectSel!.index === i)).map((x) => x.points), ...st.doc.order.filter((id) => !(rectSel!.kind === 'section' && rectSel!.id === id)).map((id) => st.doc.sections[id]!.shape.points)];
    const snap = host.geo.snapBox({ minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy }, host.geo.guideLines(others), host.geo.guidePx / scale, st.grid);
    rectProxy.position({ x: p.x + dx + snap.dx, y: p.y + dy + snap.dy });
    // 도형 윤곽도 함께 옮긴다(배치 층만 다시 그린다. 좌석은 놓을 때 옮긴다)
    lineOf(rectSel)?.position({ x: dx + snap.dx, y: dy + snap.dy });
    drawGuides(snap.guideX, snap.guideY);
  });
  rectProxy.on('dragend', () => {
    clearGuides();
    lineOf(rectSel)?.position({ x: 0, y: 0 });
    if (rectSel) commitRect(rectSel);
  });
  function lineOf(sel: CanvasSel): Line | undefined {
    if (!sel) return undefined;
    return sel.kind === 'section' ? sectionNodes.get(sel.id)?.line : stageNodes[sel.index];
  }
  rectProxy.on('transform', () => {
    const shape = shapeOfSel(rectSel);
    if (shape) showDimension([[0, 0], [rectProxy.width() * rectProxy.scaleX(), rectProxy.height() * rectProxy.scaleY()]], 'POLYGON');
    dim.position({ x: rectProxy.x(), y: rectProxy.y() - 18 / scale });
  });
  rectProxy.on('transformend', () => {
    clearGuides();
    if (rectSel) commitRect(rectSel);
  });
  function commitRect(sel: Exclude<CanvasSel, null>) {
    const p: RectParams = { x: rectProxy.x(), y: rectProxy.y(), w: rectProxy.width() * rectProxy.scaleX(), h: rectProxy.height() * rectProxy.scaleY(), rotation: rectProxy.rotation() };
    if (st.grid && p.rotation === 0) {
      p.x = host.geo.snapGrid(p.x);
      p.y = host.geo.snapGrid(p.y);
      p.w = Math.max(host.geo.gridCm, host.geo.snapGrid(p.w));
      p.h = Math.max(host.geo.gridCm, host.geo.snapGrid(p.h));
    }
    rectProxy.scale({ x: 1, y: 1 });
    host.actions.setRect(sel, p);
  }

  function handle(x: number, y: number, o: { fill?: string; radius?: number; name: string; drag?: boolean }) {
    return new Circle({ x, y, radius: (o.radius ?? 6) / scale, fill: o.fill ?? '#ffffff', stroke: COLORS.handle, strokeWidth: 1.5, strokeScaleEnabled: false, draggable: o.drag !== false, name: o.name });
  }

  function syncUi() {
    handles.destroyChildren();
    transformer.nodes([]);
    rectProxy.visible(false);
    rectSel = null;
    const sel = st.sel;
    const shape = shapeOfSel(sel);
    const editable = st.step === 1 && st.tool === 'select' && !noEdit() && shape !== undefined && sel !== null;
    if (editable && sel && shape) {
      if (isRect(shape)) {
        const p = host.geo.rectParams(shape.points);
        rectProxy.setAttrs({ x: p.x, y: p.y, width: p.w, height: p.h, rotation: p.rotation, scaleX: 1, scaleY: 1, visible: true });
        rectSel = sel;
        transformer.nodes([rectProxy]);
      } else if ((shape.kind === 'SECTOR' || shape.kind === 'ARC_BAND') && shape.arc) {
        const a = shape.arc;
        const h = host.geo.arcHandles(a);
        const keys: ('outer' | 'inner' | 'start' | 'end')[] = shape.kind === 'ARC_BAND' ? ['outer', 'inner', 'start', 'end'] : ['outer', 'start', 'end'];
        for (const k of keys) {
          const c = handle(h[k][0], h[k][1], { name: `arc-${k}`, fill: k === 'start' || k === 'end' ? '#dbeafe' : '#ffffff' });
          c.on('dragmove', () => {
            const next = host.geo.dragArcHandle(a, k, c.x(), c.y());
            const node = sel.kind === 'section' ? sectionNodes.get(sel.id)?.line : stageNodes[sel.index];
            node?.points(flat(host.geo.arcPoints(next)));
            showDimension(host.geo.arcPoints(next), shape.kind);
          });
          c.on('dragend', () => {
            clearGuides();
            host.actions.setArc(sel, host.geo.dragArcHandle(a, k, c.x(), c.y()));
          });
          handles.add(c);
        }
      } else {
        shape.points.forEach(([x, y], i) => {
          const c = handle(x, y, { name: 'vertex' });
          c.on('dragmove', () => {
            if (st.grid) c.position({ x: host.geo.snapGrid(c.x()), y: host.geo.snapGrid(c.y()) });
          });
          c.on('dragend', () => host.actions.moveVertex(sel, i, c.x(), c.y()));
          c.on('dblclick dbltap', () => host.actions.removeVertex(sel, i));
          handles.add(c);
          const [nx, ny] = shape.points[(i + 1) % shape.points.length]!;
          const plus = handle((x + nx) / 2, (y + ny) / 2, { name: 'add-vertex', radius: 5, fill: '#dbeafe', drag: false });
          plus.on('click tap', (e) => {
            e.cancelBubble = true;
            host.actions.insertVertex(sel, i);
          });
          handles.add(plus);
        });
      }
      showDimension(shape.points, shape.kind);
    } else clearGuides();
    uiLayer.batchDraw();
  }

  // ---------- 확대·이동 ----------
  /** 맞춤 배율(캔버스를 칸에 0.95배). 아주 큰 캔버스는 이것이 SCALE_MIN보다 작아도 [전체 보기]가 된다 */
  const fitScale = () => Math.min(stage.width() / st.doc.canvas.width, stage.height() / st.doc.canvas.height) * 0.95;
  const minScale = () => Math.min(SCALE_MIN, fitScale());
  function place(s: number, pos: { x: number; y: number }) {
    scale = Math.min(SCALE_MAX, Math.max(minScale(), s));
    stage.scale({ x: scale, y: scale });
    stage.position(pos);
    styleNodes();
    syncUi();
    stage.batchDraw();
    host.onView?.(scale);
  }
  /** 사람이 확대·이동하기 전에는 컨테이너 크기가 바뀌면 다시 맞춘다 */
  let userView = false;
  function fit() {
    userView = false;
    const { width, height } = st.doc.canvas;
    const s = fitScale();
    place(s, { x: (stage.width() - width * s) / 2, y: (stage.height() - height * s) / 2 });
  }
  function zoomBy(f: number, at?: { x: number; y: number }) {
    userView = true;
    const p = at ?? { x: stage.width() / 2, y: stage.height() / 2 };
    const before = { x: (p.x - stage.x()) / scale, y: (p.y - stage.y()) / scale };
    const s = Math.min(SCALE_MAX, Math.max(minScale(), scale * f));
    place(s, { x: p.x - before.x * s, y: p.y - before.y * s });
  }
  stage.on('wheel', (e) => {
    e.evt.preventDefault();
    const p = stage.getPointerPosition();
    zoomBy(e.evt.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR, p ?? undefined);
  });

  // ---------- 누르기·끌기 ----------
  let space = false;
  let pan: { x: number; y: number; sx: number; sy: number } | null = null;
  let boxStart: Pt | null = null;
  let seatDragStart: Pt | null = null;
  let drawStart: Pt | null = null;
  let poly: Pt[] = [];
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) space = e.type === 'keydown';
    if (e.type !== 'keydown' || st.tool !== 'polygon') return;
    if (e.key === 'Escape') {
      poly = [];
      draftLine.visible(false);
      uiLayer.batchDraw();
    } else if (e.key === 'Enter' && poly.length >= 3) finishPolygon();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  function finishPolygon() {
    const pts = poly;
    poly = [];
    draftLine.visible(false);
    if (pts.length >= 3) host.actions.addPolygon(pts.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt));
  }

  /** 찍은 점(격자 맞춤, 캔버스 안으로 자른다, ADR-0264 결정 36) */
  const snapPt = (p: { x: number; y: number }): Pt => {
    const { width, height } = st.doc.canvas;
    const x = Math.min(width, Math.max(0, st.grid ? host.geo.snapGrid(p.x) : Math.round(p.x)));
    const y = Math.min(height, Math.max(0, st.grid ? host.geo.snapGrid(p.y) : Math.round(p.y)));
    return [x, y];
  };
  /** 창 좌표 → 세계 좌표(캔버스 밖에서 놓았을 때) */
  const worldOf = (clientX: number, clientY: number) => {
    const r = stage.container().getBoundingClientRect();
    return { x: (clientX - r.left - stage.x()) / scale, y: (clientY - r.top - stage.y()) / scale };
  };

  stage.on('mousedown touchstart', (e) => {
    const target = e.target;
    const onEmpty = target === stage || target.getLayer() === gridLayer;
    const evt = e.evt as MouseEvent;
    const w = world();
    if (space || evt.button === 1) {
      pan = { x: stage.x(), y: stage.y(), sx: evt.clientX ?? 0, sy: evt.clientY ?? 0 };
      return;
    }
    if (st.step === 1 && st.tool !== 'select') {
      if (!noEdit() && (st.tool === 'rect' || st.tool === 'stage')) drawStart = snapPt(w);
      return;
    }
    if (st.step === 3) {
      if (st.tool === 'insertSeat') {
        if (!noEdit()) host.actions.insertSeat(w.x, w.y);
        return;
      }
      const hit = host.actions.pickSeat(w.x, w.y);
      if (hit) {
        if (!st.seatSel.has(hit)) host.actions.selectSeats([hit], evt.shiftKey);
        if (!noEdit()) seatDragStart = [w.x, w.y];
        return;
      }
      boxStart = [w.x, w.y];
      return;
    }
    if (st.step === 4) return;
    if (onEmpty) {
      if (st.step === 1 || st.step === 2) host.actions.select(null);
      pan = { x: stage.x(), y: stage.y(), sx: evt.clientX ?? 0, sy: evt.clientY ?? 0 };
    }
  });
  stage.on('mousemove touchmove', (e) => {
    const evt = e.evt as MouseEvent;
    const w = world();
    if (pan) {
      userView = true;
      stage.position({ x: pan.x + (evt.clientX - pan.sx), y: pan.y + (evt.clientY - pan.sy) });
      stage.batchDraw();
      return;
    }
    if (drawStart) {
      const [x0, y0] = drawStart;
      const [x1, y1] = snapPt(w);
      draftLine.points([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]);
      draftLine.visible(true);
      uiLayer.batchDraw();
      return;
    }
    if (st.tool === 'polygon' && poly.length > 0) {
      draftLine.points(flat([...poly, snapPt(w)]));
      draftLine.visible(true);
      uiLayer.batchDraw();
      return;
    }
    if (seatDragStart) {
      seatDrag = [Math.round(w.x - seatDragStart[0]), Math.round(w.y - seatDragStart[1])];
      seatLayer.batchDraw();
      return;
    }
    if (boxStart) {
      boxRect.setAttrs({ x: Math.min(boxStart[0], w.x), y: Math.min(boxStart[1], w.y), width: Math.abs(w.x - boxStart[0]), height: Math.abs(w.y - boxStart[1]), visible: true });
      uiLayer.batchDraw();
    }
  });
  /** 끌기·이동·상자·그리기를 끝낸다. 캔버스 밖에서 놓았으면 그 점을 캔버스 안으로 자른 자리에서 끝낸다(ADR-0264 결정 38) */
  const finish = (raw: { x: number; y: number }, shift: boolean) => {
    const { width, height } = st.doc.canvas;
    const w = { x: Math.min(width, Math.max(0, raw.x)), y: Math.min(height, Math.max(0, raw.y)) };
    if (pan) {
      pan = null;
      return;
    }
    if (drawStart) {
      const [x0, y0] = drawStart;
      const [x1, y1] = snapPt(w);
      drawStart = null;
      draftLine.visible(false);
      host.actions.addRect(st.tool === 'stage' ? 'stage' : 'section', x0, y0, x1, y1);
      return;
    }
    if (seatDragStart) {
      const d: Pt = [Math.round(w.x - seatDragStart[0]), Math.round(w.y - seatDragStart[1])];
      seatDragStart = null;
      seatDrag = null;
      if (d[0] !== 0 || d[1] !== 0) host.actions.moveSeats(d[0], d[1]);
      else seatLayer.batchDraw();
      return;
    }
    if (boxStart) {
      const [x0, y0] = boxStart;
      boxStart = null;
      boxRect.visible(false);
      uiLayer.batchDraw();
      if (Math.abs(w.x - x0) * scale < 3 && Math.abs(w.y - y0) * scale < 3) {
        if (!shift) host.actions.selectSeats([], false);
        return;
      }
      host.actions.selectSeats(host.actions.boxSeats({ minX: Math.min(x0, w.x), minY: Math.min(y0, w.y), maxX: Math.max(x0, w.x), maxY: Math.max(y0, w.y) }), shift);
    }
  };
  const active = () => pan !== null || drawStart !== null || seatDragStart !== null || boxStart !== null;
  stage.on('mouseup touchend', (e) => finish(world(), (e.evt as MouseEvent).shiftKey === true));
  // 캔버스 밖에서 놓아도 끝낸다(Stage는 제 칸 밖의 놓기를 받지 못한다)
  const onWindowUp = (e: PointerEvent | MouseEvent) => {
    if (active()) finish(worldOf(e.clientX, e.clientY), e.shiftKey);
  };
  window.addEventListener('pointerup', onWindowUp);
  window.addEventListener('mouseup', onWindowUp);
  stage.on('click tap', () => {
    const w = world();
    if (st.step === 1 && !noEdit() && st.tool === 'polygon') {
      poly.push(snapPt(w));
      if (poly.length >= 2) {
        draftLine.points(flat(poly));
        draftLine.visible(true);
        uiLayer.batchDraw();
      }
    } else if (st.step === 1 && !noEdit() && (st.tool === 'sector' || st.tool === 'arcband')) host.actions.addArc(st.tool === 'sector' ? 'SECTOR' : 'ARC_BAND', w.x, w.y);
    else if (st.step === 2) {
      const id = host.actions.sectionAt(w.x, w.y);
      if (id) host.actions.select({ kind: 'section', id });
    }
  });
  stage.on('dblclick dbltap', (ev) => {
    const w = world();
    if (st.step === 1 && st.tool === 'polygon') {
      // 두 번 누름의 두 번째 점은 이미 들어갔다
      poly.pop();
      finishPolygon();
    } else if (st.step === 3) {
      const hit = host.actions.pickSeat(w.x, w.y);
      if (hit) host.actions.selectSeats(host.actions.rowSeats(hit), (ev.evt as MouseEvent).shiftKey === true);
    }
  });

  // ---------- 저장소 구독 ----------
  const unsub = host.subscribe((next, prev) => {
    st = next;
    if (next.rev !== prev.rev || next.doc !== prev.doc) {
      syncLayout(next.touched.sections, next.touched.stage);
      if (next.doc.canvas !== prev.doc.canvas) gridLayer.batchDraw();
    }
    if (next.step !== prev.step || next.tool !== prev.tool || next.sel !== prev.sel || next.locked !== prev.locked || next.saving !== prev.saving || next.rev !== prev.rev) {
      if (next.tool !== 'polygon') {
        poly = [];
        draftLine.visible(false);
      }
      styleNodes();
      syncUi();
    }
    if (next.grid !== prev.grid) gridLayer.batchDraw();
    stage.container().style.cursor = next.step === 1 && next.tool !== 'select' ? 'crosshair' : next.step === 3 && next.tool === 'insertSeat' ? 'copy' : 'default';
    layoutLayer.batchDraw();
    seatLayer.batchDraw();
  });

  const ro = new ResizeObserver(() => {
    stage.size({ width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) });
    if (userView) stage.batchDraw();
    else fit();
  });
  ro.observe(el);

  syncLayout('all', true);
  fit();

  return {
    fit,
    zoomBy: (f) => zoomBy(f),
    scale: () => scale,
    toScreen: (x, y) => [stage.x() + x * scale, stage.y() + y * scale],
    destroy() {
      unsub();
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('mouseup', onWindowUp);
      stage.destroy();
    },
  };
}
