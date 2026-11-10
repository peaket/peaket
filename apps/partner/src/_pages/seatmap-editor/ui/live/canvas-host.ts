// 편집 캔버스(CMP-051)와 에디터 저장소를 잇는다(ADR-0264 결정 3·4). 캔버스는 저장소를 React 밖에서 구독하고, 손잡이를 놓으면 여기의 함수가 명령 하나를 만든다.
// 좌석 찾기는 격자 색인(@peaket/seatmap/grid buildGrids·hitTest)이고 문서가 바뀌면 다음에 찾을 때 다시 만든다.
import type { CanvasHost, CanvasSel } from '@/widgets/seatmap-canvas';
import { buildSeatIndex, seatAt, seatsInBoxIndexed, type SeatIndex } from '../../model/seat-index';
import { insertSeat, moveSeats, rowSeatIds } from '../../model/refine';
import {
  arcHandles,
  arcPoints,
  bbox,
  centroid,
  defaultArc,
  dimensionText,
  dragArcHandle,
  GRID_CM,
  GUIDE_SNAP_PX,
  guideLines,
  insertVertex,
  isRectLike,
  moveShape,
  moveVertex,
  polygonFromClicks,
  pointInPolygon,
  rectFromDrag,
  rectParams,
  removeVertex,
  snapBox,
  snapGrid,
  withArc,
  withRect,
} from '../../model/shapes';
import { addShapeCmd, type EditorStore, seatsCmd, updateSectionCmd, updateStageCmd } from '../../model/store';
import { sectionOf, type Shape } from '../../model/types';

export function canvasHost(store: EditorStore, onView: (scale: number) => void, notify: (text: string) => void): CanvasHost {
  let index: { rev: number; ix: SeatIndex | null } | null = null;
  const seatIndex = () => {
    const s = store.getState();
    if (!index || index.rev !== s.rev) index = { rev: s.rev, ix: buildSeatIndex(s.doc) };
    return index.ix;
  };
  const shapeOf = (sel: Exclude<CanvasSel, null>): Shape | undefined => {
    const d = store.getState().doc;
    return sel.kind === 'stage' ? d.stage[sel.index] : sectionOf(d, sel.id)?.shape;
  };
  const putShape = (sel: Exclude<CanvasSel, null>, shape: Shape) => {
    const s = store.getState();
    s.exec(sel.kind === 'stage' ? updateStageCmd(s.doc, sel.index, shape) : updateSectionCmd(s.doc, sel.id, { shape }));
  };
  return {
    getState: () => store.getState(),
    subscribe: (fn) => store.subscribe((s, prev) => fn(s, prev)),
    geo: { rectParams, isRectLike, arcHandles, dragArcHandle, arcPoints, bbox, centroid, snapBox, guideLines, snapGrid, dimensionText, guidePx: GUIDE_SNAP_PX, gridCm: GRID_CM },
    actions: {
      select: (sel) => store.getState().select(sel),
      moveShape(sel, dx, dy) {
        const sh = shapeOf(sel);
        if (sh) putShape(sel, moveShape(sh, dx, dy, store.getState().doc.canvas));
      },
      setRect(sel, p) {
        const sh = shapeOf(sel);
        if (sh) putShape(sel, withRect(sh, p, store.getState().doc.canvas));
      },
      setArc(sel, a) {
        const sh = shapeOf(sel);
        if (sh) putShape(sel, withArc(sh, a, store.getState().doc.canvas));
      },
      moveVertex(sel, i, x, y) {
        const sh = shapeOf(sel);
        if (sh) putShape(sel, moveVertex(sh, i, x, y, store.getState().doc.canvas));
      },
      insertVertex(sel, edge) {
        const sh = shapeOf(sel);
        if (sh) putShape(sel, insertVertex(sh, edge));
      },
      removeVertex(sel, i) {
        const sh = shapeOf(sel);
        if (sh) putShape(sel, removeVertex(sh, i));
      },
      addRect(target, x0, y0, x1, y1) {
        const s = store.getState();
        const p = rectFromDrag(x0, y0, x1, y1, s.grid);
        const shape = withRect({ kind: 'RECT', points: [] }, p, s.doc.canvas);
        const id = s.newSectionId();
        if (s.exec(addShapeCmd(s.doc, target, shape, id))) {
          s.select(target === 'stage' ? { kind: 'stage', index: store.getState().doc.stage.length - 1 } : { kind: 'section', id });
          s.setTool('select');
        }
      },
      addPolygon(clicks) {
        const s = store.getState();
        // 찍은 점은 캔버스 안 정수로 잘라 넣는다(ADR-0264 결정 36)
        const points = polygonFromClicks(clicks, s.doc.canvas);
        if (points.length < 3) return notify('꼭짓점을 세 개 이상 찍어 주세요');
        const id = s.newSectionId();
        if (s.exec(addShapeCmd(s.doc, 'section', { kind: 'POLYGON', points }, id))) {
          s.select({ kind: 'section', id });
          s.setTool('select');
        }
      },
      addArc(kind, x, y) {
        const s = store.getState();
        const shape = withArc({ kind, points: [] }, defaultArc(kind, x, y), s.doc.canvas);
        const id = s.newSectionId();
        if (s.exec(addShapeCmd(s.doc, 'section', shape, id))) {
          s.select({ kind: 'section', id });
          s.setTool('select');
        }
      },
      pickSeat: (x, y) => seatAt(seatIndex(), x, y),
      boxSeats: (box) => seatsInBoxIndexed(seatIndex(), box),
      rowSeats: (id) => rowSeatIds(store.getState().doc, id),
      selectSeats: (ids, add) => store.getState().selectSeats(ids, add),
      moveSeats(dx, dy) {
        const s = store.getState();
        const r = moveSeats(s.doc, s.seatSel, dx, dy);
        s.exec(seatsCmd(s.doc, '좌석 옮기기', r.changes));
      },
      insertSeat(x, y) {
        const s = store.getState();
        const id = s.doc.order.find((sid) => pointInPolygon(sectionOf(s.doc, sid)!.shape.points, x, y));
        if (!id) return notify('구역 도형 안을 눌러 좌석을 넣어 주세요');
        const r = insertSeat(s.doc, id, [x, y], s.newSeatId());
        if (r && s.exec(seatsCmd(s.doc, '좌석 넣기', r.changes))) s.selectSeats([r.seat.seatId]);
      },
      sectionAt(x, y) {
        const d = store.getState().doc;
        for (let i = d.order.length - 1; i >= 0; i--) {
          const id = d.order[i]!;
          if (pointInPolygon(sectionOf(d, id)!.shape.points, x, y)) return id;
        }
        return null;
      },
    },
    onView,
  };
}
