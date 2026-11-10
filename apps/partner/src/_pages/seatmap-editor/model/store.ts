// 좌석맵 에디터 저장소(docs/frontend.md §3.9, ADR-0264 결정 4·8·13). Zustand 바닐라 저장소 하나(subscribeWithSelector)에 문서·판·화면 상태를 둔다.
// 편집은 모두 명령이다. 명령은 바뀐 칸(구역·무대·차례·가격 등급·캔버스)의 앞뒤 값을 들고, 되돌리기 스택은 200단계 [가정]이다(넘으면 가장 오래된 것부터 버린다).
// 캔버스는 React 밖에서 rev·touched를 구독해 바뀐 구역만 다시 그린다. 저장에 성공하면 서버 응답으로 문서를 갈아끼우고 되돌리기 기록을 비운다
// (새 좌석의 ID가 바뀌어 옛 명령이 가리킬 좌석이 없다). 잠긴 배치본(geometryLocked)은 도형·좌석 명령을 받지 않는다(서버의 409가 최종 판정이다).
// 브라우저 저장소에는 아무것도 넣지 않는다(탭 메모리만, ADR-0264 결정 8).
import { subscribeWithSelector } from 'zustand/middleware';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DUPLICATE_OFFSET_CM, mirrorAxis, mirrorTransform, moveShape } from './shapes.ts';
import { setOwn, sectionOf } from './types.ts';
import type { SectionChanges } from './refine.ts';
import type { EditorDoc, FillRule, Seat, Section, Shape, Tier } from './types.ts';

/** 되돌리기 상한 [가정](frontend §3.9, FR-023의 10단계를 넘는다) */
export const UNDO_LIMIT = 200;

export type Step = 1 | 2 | 3 | 4;
export type Tool = 'select' | 'stage' | 'rect' | 'polygon' | 'sector' | 'arcband' | 'insertSeat';
export type ShapeSel = { kind: 'section'; id: string } | { kind: 'stage'; index: number } | null;

/** 문서의 일부를 바꾸는 값. sections의 null은 지운다. doc는 문서 바꾸기(가져오기) */
export interface DocPatch {
  doc?: EditorDoc;
  sections?: Record<string, Section | null>;
  order?: readonly string[];
  stage?: readonly Shape[];
  priceTiers?: readonly Tier[];
  canvas?: { width: number; height: number };
}

export interface Command {
  label: string;
  before: DocPatch;
  after: DocPatch;
  /** 도형·좌석·가격 등급을 바꾸는가(잠긴 배치본은 받지 않는다) */
  geometry: boolean;
}

/** 마지막 변경이 건드린 것(캔버스가 그 구역 노드만 고친다) */
export interface Touched {
  sections: readonly string[] | 'all';
  stage: boolean;
}

export interface EditorState {
  doc: EditorDoc;
  /** 불러온·저장한 판(ETag). 배치본이 없으면 0 */
  version: number;
  locked: boolean;
  past: Command[];
  future: Command[];
  /** 마지막 불러오기·저장 뒤 명령 수('변경 n건 · 저장 전') */
  changes: number;
  /** 문서가 바뀔 때마다 1씩 오른다 */
  rev: number;
  touched: Touched;
  step: Step;
  tool: Tool;
  sel: ShapeSel;
  seatSel: ReadonlySet<string>;
  grid: boolean;
  /** [좌석맵 저장] 요청이 오가는 중(편집을 받지 않는다, ADR-0264 결정 30) */
  saving: boolean;
  /** 채우기 미리보기의 흐린 좌석(구역 하나) */
  ghost: { sectionId: string; seats: readonly { x: number; y: number }[] } | null;
}

export interface EditorActions {
  /** 불러오기·저장 성공: 문서를 갈아끼우고 되돌리기 기록과 변경 수를 비운다 */
  reset(doc: EditorDoc, version: number, locked: boolean): void;
  exec(cmd: Command | null): boolean;
  undo(): boolean;
  redo(): boolean;
  newSeatId(): string;
  newSectionId(): string;
  setStep(step: Step): void;
  setTool(tool: Tool): void;
  select(sel: ShapeSel): void;
  selectSeats(ids: Iterable<string>, add?: boolean): void;
  setGrid(on: boolean): void;
  setGhost(g: EditorState['ghost']): void;
  setSaving(on: boolean): void;
}

export type EditorStore = StoreApi<EditorState & EditorActions>;

export function applyPatch(doc: EditorDoc, p: DocPatch): EditorDoc {
  if (p.doc) return p.doc;
  let sections = doc.sections;
  if (p.sections) {
    // 구역 ID는 바깥 글자라 대입하지 않고 자기 칸으로 정의한다('__proto__' 같은 이름도 문서의 칸이다)
    const next: Record<string, Section> = { ...doc.sections };
    for (const [id, s] of Object.entries(p.sections)) {
      if (s === null) delete next[id];
      else setOwn(next, id, s);
    }
    sections = next;
  }
  return {
    ...doc,
    sections,
    ...(p.order ? { order: p.order } : {}),
    ...(p.stage ? { stage: p.stage } : {}),
    ...(p.priceTiers ? { priceTiers: p.priceTiers } : {}),
    ...(p.canvas ? { canvas: p.canvas } : {}),
  };
}

/** after가 바꾸는 칸의 지금 값(되돌릴 값) */
function beforeOf(doc: EditorDoc, after: DocPatch): DocPatch {
  if (after.doc) return { doc };
  const b: DocPatch = {};
  if (after.sections) b.sections = Object.fromEntries(Object.keys(after.sections).map((id) => [id, sectionOf(doc, id) ?? null]));
  if (after.order) b.order = doc.order;
  if (after.stage) b.stage = doc.stage;
  if (after.priceTiers) b.priceTiers = doc.priceTiers;
  if (after.canvas) b.canvas = doc.canvas;
  return b;
}

export const command = (doc: EditorDoc, label: string, after: DocPatch, geometry = true): Command => ({ label, before: beforeOf(doc, after), after, geometry });

function touchedOf(p: DocPatch): Touched {
  if (p.doc || p.canvas || p.order) return { sections: 'all', stage: true };
  return { sections: Object.keys(p.sections ?? {}), stage: p.stage !== undefined };
}

/** 지운 구역·좌석을 고른 것에서 뺀다(지우는 명령 뒤 고른 것·트리 줄을 다시 본다) */
function pruneSel(doc: EditorDoc, sel: ShapeSel, seatSel: ReadonlySet<string>): { sel: ShapeSel; seatSel: ReadonlySet<string> } {
  const s = sel && ((sel.kind === 'section' && !sectionOf(doc, sel.id)) || (sel.kind === 'stage' && sel.index >= doc.stage.length)) ? null : sel;
  if (seatSel.size === 0) return { sel: s, seatSel };
  const alive = new Set<string>();
  for (const id of doc.order) for (const x of doc.sections[id]!.seats) if (seatSel.has(x.seatId)) alive.add(x.seatId);
  return { sel: s, seatSel: alive.size === seatSel.size ? seatSel : alive };
}

export interface StoreOptions {
  /** 에디터가 새로 만든 좌석·구역 ID의 앞머리(시험은 고정 값을 준다). 서버가 좌석은 UUIDv7로 바꾼다 */
  idPrefix?: string;
}

export function createEditorStore(doc: EditorDoc, version: number, locked: boolean, o: StoreOptions = {}): EditorStore {
  const prefix = o.idPrefix ?? Math.random().toString(36).slice(2, 6);
  let seatSeq = 0;
  return createStore<EditorState & EditorActions>()(
    subscribeWithSelector((set, get) => ({
      doc,
      version,
      locked,
      past: [],
      future: [],
      changes: 0,
      rev: 0,
      touched: { sections: 'all', stage: true },
      step: 1,
      tool: 'select',
      sel: null,
      seatSel: new Set(),
      grid: true,
      saving: false,
      ghost: null,
      reset(next, v, lock) {
        const st = get();
        set({ doc: next, version: v, locked: lock, past: [], future: [], changes: 0, rev: st.rev + 1, touched: { sections: 'all', stage: true }, ghost: null, ...pruneSel(next, st.sel, new Set()) });
      },
      exec(cmd) {
        if (!cmd) return false;
        const st = get();
        if (st.saving || (st.locked && cmd.geometry)) return false;
        const next = applyPatch(st.doc, cmd.after);
        const past = [...st.past, cmd];
        if (past.length > UNDO_LIMIT) past.shift();
        set({ doc: next, past, future: [], changes: st.changes + 1, rev: st.rev + 1, touched: touchedOf(cmd.after), ghost: null, ...pruneSel(next, st.sel, st.seatSel) });
        return true;
      },
      undo() {
        const st = get();
        const cmd = st.past.at(-1);
        if (!cmd || st.saving) return false;
        const next = applyPatch(st.doc, cmd.before);
        set({ doc: next, past: st.past.slice(0, -1), future: [...st.future, cmd], changes: Math.max(0, st.changes - 1), rev: st.rev + 1, touched: touchedOf(cmd.before), ghost: null, ...pruneSel(next, st.sel, st.seatSel) });
        return true;
      },
      redo() {
        const st = get();
        const cmd = st.future.at(-1);
        if (!cmd || st.saving) return false;
        if (st.locked && cmd.geometry) return false;
        const next = applyPatch(st.doc, cmd.after);
        set({ doc: next, past: [...st.past, cmd].slice(-UNDO_LIMIT), future: st.future.slice(0, -1), changes: st.changes + 1, rev: st.rev + 1, touched: touchedOf(cmd.after), ghost: null, ...pruneSel(next, st.sel, st.seatSel) });
        return true;
      },
      newSeatId: () => `new-${prefix}-${++seatSeq}`,
      newSectionId() {
        const used = new Set(get().doc.order);
        for (let n = used.size + 1; ; n++) if (!used.has(`s${n}`)) return `s${n}`;
      },
      setStep: (step) => set({ step, tool: step === 1 ? get().tool : 'select', ghost: null }),
      setTool: (tool) => set({ tool }),
      select: (sel) => set({ sel }),
      selectSeats(ids, add = false) {
        const next = new Set(add ? get().seatSel : []);
        for (const id of ids) next.add(id);
        set({ seatSel: next });
      },
      setGrid: (grid) => set({ grid }),
      setGhost: (ghost) => set({ ghost }),
      setSaving: (saving) => set({ saving }),
    })),
  );
}

// ---------- 명령 만들기(저장소 밖에서도 쓰는 순수 함수) ----------

/** 새 구역 이름 '구역 n': 지금 있는 이름과 겹치지 않는 가장 작은 n(CSV·SVG는 이름이 곧 구역이다, ADR-0264 결정 36) */
export function newSectionName(doc: EditorDoc): string {
  const used = new Set(doc.order.map((id) => sectionOf(doc, id)?.name));
  for (let n = 1; ; n++) if (!used.has(`구역 ${n}`)) return `구역 ${n}`;
}

/** 도형 더하기: 무대면 무대 목록 끝, 구역이면 새 구역(이름 '구역 n') */
export function addShapeCmd(doc: EditorDoc, target: 'stage' | 'section', shape: Shape, sectionId: string): Command {
  if (target === 'stage') return command(doc, '무대 더하기', { stage: [...doc.stage, { ...shape, name: shape.name ?? '무대' }] });
  const sec: Section = { sectionId, name: newSectionName(doc), shape, seats: [] };
  return command(doc, '구역 더하기', { sections: { [sectionId]: sec }, order: [...doc.order, sectionId] });
}

/** 구역 칸 고치기. 게이트만 바꾸면 잠긴 배치본에서도 받는다 */
export function updateSectionCmd(doc: EditorDoc, id: string, patch: Partial<Omit<Section, 'sectionId' | 'seats'>>): Command | null {
  const s = sectionOf(doc, id);
  if (!s) return null;
  const next: Section = { ...s };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
    else (next as unknown as Record<string, unknown>)[k] = v;
  }
  const gateOnly = Object.keys(patch).every((k) => k === 'gateZone' || k === 'fillRule');
  return command(doc, '구역 고치기', { sections: { [id]: next } }, !gateOnly);
}

export function updateStageCmd(doc: EditorDoc, index: number, shape: Shape): Command | null {
  if (!doc.stage[index]) return null;
  return command(doc, '무대 고치기', { stage: doc.stage.map((s, i) => (i === index ? shape : s)) });
}

export function removeShapeCmd(doc: EditorDoc, sel: Exclude<ShapeSel, null>): Command | null {
  if (sel.kind === 'stage') return doc.stage[sel.index] ? command(doc, '무대 지우기', { stage: doc.stage.filter((_, i) => i !== sel.index) }) : null;
  if (!sectionOf(doc, sel.id)) return null;
  return command(doc, '구역 지우기', { sections: { [sel.id]: null }, order: doc.order.filter((x) => x !== sel.id) });
}

/** 구역 복제(1m 옮긴 자리, 좌석도 새 ID로) 또는 좌우 대칭 복제(대칭축의 거울 꼴, 좌석 x도 거울) */
export function copySectionCmd(doc: EditorDoc, id: string, newId: string, seatId: () => string, mode: 'duplicate' | 'mirror'): Command | null {
  const s = sectionOf(doc, id);
  if (!s) return null;
  let shape: Shape;
  let seats: Seat[];
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  if (mode === 'mirror') {
    // 좌석은 도형과 같은 변환(거울 + 캔버스 안으로 옮긴 만큼)으로 따라간다
    const axis = mirrorAxis(doc.stage, doc.canvas);
    const t = mirrorTransform(s.shape, axis, doc.canvas);
    shape = t.shape;
    seats = s.seats.map((x) => ({ ...x, seatId: seatId(), x: clamp(2 * axis - x.x + t.dx, doc.canvas.width), y: clamp(x.y + t.dy, doc.canvas.height) }));
  } else {
    shape = moveShape(s.shape, DUPLICATE_OFFSET_CM, DUPLICATE_OFFSET_CM, doc.canvas);
    const dx = shape.points[0]![0] - s.shape.points[0]![0];
    const dy = shape.points[0]![1] - s.shape.points[0]![1];
    seats = s.seats.map((x) => ({ ...x, seatId: seatId(), x: x.x + dx, y: x.y + dy }));
  }
  const { label: _l, ...rest } = s;
  const copy: Section = { ...rest, sectionId: newId, name: newSectionName(doc), shape, seats };
  return command(doc, mode === 'mirror' ? '좌우 대칭 복제' : '복제', { sections: { [newId]: copy }, order: [...doc.order, newId] });
}

/** 구역 채우기: 좌석을 바꾸고 채우기 규칙을 저장한다 */
export function fillCmd(doc: EditorDoc, id: string, seats: readonly Seat[], rule: FillRule): Command | null {
  const s = sectionOf(doc, id);
  if (!s) return null;
  return command(doc, '구역 채우기', { sections: { [id]: { ...s, seats, fillRule: rule } } });
}

/** 좌석 명령(refine.ts가 만든 바뀐 구역). 좌석 속성 중 판매 제외·휠체어석·게이트만 바꾼 것은 잠긴 배치본에서도 받는다 */
export function seatsCmd(doc: EditorDoc, label: string, changes: SectionChanges, geometry = true): Command | null {
  if (Object.keys(changes).length === 0) return null;
  return command(doc, label, { sections: changes }, geometry);
}

export function tiersCmd(doc: EditorDoc, tiers: readonly Tier[]): Command {
  return command(doc, '가격 등급', { priceTiers: tiers });
}

/** 캔버스 크기(모든 도형·좌석이 새 캔버스 안일 때만) */
export function canvasCmd(doc: EditorDoc, width: number, height: number): Command | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 100_000 || height > 100_000) return null;
  const inside = (x: number, y: number) => x <= width && y <= height;
  const shapes = [...doc.stage, ...doc.order.map((id) => doc.sections[id]!.shape)];
  if (!shapes.every((s) => s.points.every(([x, y]) => inside(x, y)))) return null;
  if (!doc.order.every((id) => doc.sections[id]!.seats.every((x) => inside(x.x, x.y)))) return null;
  return command(doc, '캔버스 크기', { canvas: { width, height } });
}

/** 문서 바꾸기(가져오기 반영, 되돌릴 수 있다) */
export const replaceCmd = (doc: EditorDoc, next: EditorDoc): Command => command(doc, '가져온 파일로 바꾸기', { doc: next });
