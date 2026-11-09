// 좌석맵 그리기 엔진(docs/frontend.md §5.2, §1.5 'OffscreenCanvas 2D' 행, CMP-021, docs/design/d5 좌석맵 상태 표, BUILD_ORDER HOT-110·HOT-120).
// Worker와 메인 스레드 대체가 같은 코드를 쓴다(OffscreenCanvas가 없는 브라우저는 같은 그리기 모듈을 메인 스레드에서 돌린다, FE-T15).
// 단계: loading(스냅샷 전, 구역 외곽선만) → overview(무대·구역 면에 등급 색과 남은 상태 글자, 좌석은 그리지 않는다)
// → seats(화면에 보이는 구역 하나라도 화면 폭의 1/3 이상 [가정]이면 보이는 구역의 좌석. 축소하면 다시 구역 면으로 합쳐진다).
// seats에서 좌석이 24 CSS px 미만이면 구역 비트맵(캐시)을 늘려 그리고, 24px 이상(고를 수 있는 배율)이면 보이는 좌석만 바로 그린다.
// 확대·축소는 카메라 행렬만 바꾼다(seat-hold §10). 미니맵(지금 보는 범위)은 seats 단계에서 캔버스 오른쪽 아래에 그린다.
import { color } from '@peaket/ds/tokens';
import { BitmapCache, scaleBucket } from './bitmaps';
import { buildGrids, cameraFit, hitAtScreen, type Camera, type SectionGrid } from './grid';
import { FLAG, decodeLayout, sectionOf, seatIdOf, type DecodedLayout, type SeatMapColumnsFile } from './layout';
import { overviewPalette, pointInPolygon, sectionStatus, sectionTierMask, sectionTiers, STATUS_LABEL, tierFace } from './overview';
import { drawSeat, seatState, seatStyle, type ColorMode, type Ctx2D } from './paint';
import { applyDelta, applySnapshot, decodeSnapshot, STATE, type DeltaDecision, type Frame, type SectionVersions, type Snapshot } from './wire';

/** 좌석 한 변(cm) [가정] */
export const SEAT_CM = 50;
/** 이 크기(CSS px) 이상이면 좌석을 그린다(그보다 작으면 seats 단계여도 구역 면만) */
export const SEAT_DRAW_MIN_PX = 2;
/** 좌석을 고를 수 있는 가장 작은 크기(CSS px, §5.11·CMP-021 minSeatPx). 그보다 작으면 누른 좌석이 없다 */
export const MIN_SELECT_PX = 24;
/** 보이는 구역이 화면 폭의 이 비율 이상이면 좌석 단계 [가정](CMP-021, seat-hold §10) */
export const SEATS_SECTION_RATIO = 1 / 3;
/** [+]·[−] 한 번의 배율 [가정] */
export const ZOOM_STEP = 1.5;
/** 가장 크게 확대한 좌석 크기(CSS px) [가정] */
export const MAX_SEAT_PX = 64;
/** 마우스를 올린 좌석의 크기 배수 [가정]. 좌석이 칸의 80%라 1.2배면 이웃 좌석을 덮지 않는다(ADR-0236) */
export const HOVER_SCALE = 1.2;
/** 마우스를 올린 좌석의 테두리 두께(CSS px) */
export const HOVER_RING_PX = 2;
/** 좌석과 테두리 사이의 바탕색 틈(CSS px). 내가 고른 좌석은 테두리와 색이 같거나 비슷해 틈이 있어야 보인다. 24px 좌석에서도 이웃을 덮지 않는 값이다 */
export const HOVER_GAP_PX = 1;
/** 고를 수 없는 배율에서 좌석을 눌렀을 때 확대해 맞추는 좌석 크기(CSS px) [가정] */
export const SELECT_ZOOM_PX = 32;
/** 미니맵 폭(CSS px)과 화면 가장자리 여백 [가정] */
export const MINIMAP = { width: 120, margin: 12 } as const;

export type Level = 'loading' | 'overview' | 'seats';

/** drawImage가 있는 2D 문맥(구역 비트맵을 늘려 그릴 때) */
type ImageCtx = Ctx2D & { drawImage(image: unknown, x: number, y: number, w: number, h: number): void };

/** 구역 비트맵을 만드는 쪽(Worker는 OffscreenCanvas, 메인 스레드는 OffscreenCanvas나 canvas 요소, 시험은 가짜) */
export interface BitmapFactory {
  create(w: number, h: number): { ctx: Ctx2D; finish(): { image: unknown; close?: () => void } };
}

export interface EngineOptions {
  ctx: Ctx2D;
  width: number;
  height: number;
  dpr: number;
  theme: ColorMode;
  bitmaps?: BitmapFactory;
  /** 등급 ID를 가격이 높은 차례로(화면이 회차 가격표로 정한다). 없으면 좌석맵 파일 tiers 차례 */
  tierRank?: readonly string[];
  /** 등급 ID → 화면 글자(회차 가격표). 없으면 파일의 ID를 그대로 쓴다 */
  tierNames?: Readonly<Record<string, string>>;
}

export class SeatMapEngine {
  L!: DecodedLayout;
  grids!: SectionGrid[];
  state!: Uint8Array;
  /** 내가 고른 좌석(비트 배열, ⌈N/8⌉) */
  mine!: Uint8Array;
  versions!: SectionVersions;
  tiers!: Uint8Array;
  /** 등급 색인 → 가격 차례 */
  rank!: Uint8Array;
  /** 구역마다 있는 등급(비트) */
  tierMask!: Uint16Array;

  /** 구역의 등급 글자: 좌석이 있는 등급을 모두 가격 차례로(면 색은 가장 많은 등급) */
  tierLabel(s: number): string {
    const ids: number[] = [];
    for (let t = 0; t < 16; t++) if ((this.tierMask[s]! >> t) & 1) ids.push(t);
    return ids.sort((a, b) => this.rank[a]! - this.rank[b]! || a - b).map((t) => { const id = this.L.file.tiers[t]!; return this.o.tierNames?.[id] ?? id; }).join('·');
  }
  /** 스냅샷을 받았는가(받기 전은 loading) */
  hasState = false;
  /** 마우스를 올린 고를 수 있는 좌석(없으면 -1) */
  hovered = -1;
  cam: Camera = { scale: 1, tx: 0, ty: 0 };
  readonly cache = new BitmapCache();
  private o: EngineOptions;

  constructor(o: EngineOptions) {
    this.o = { ...o };
  }

  /** 등급 색인 → 가격 차례(0이 가장 비싸다) */
  private applyRank(): void {
    const rank = this.o.tierRank;
    this.rank = Uint8Array.from(this.L.file.tiers, (t, i) => {
      if (!rank) return i;
      const r = rank.indexOf(t);
      return r < 0 ? 255 : r;
    });
  }

  load(file: SeatMapColumnsFile, snapshot?: ArrayBuffer | Uint8Array): void {
    this.L = decodeLayout(file);
    this.grids = buildGrids(this.L);
    this.tiers = sectionTiers(this.L);
    this.tierMask = sectionTierMask(this.L);
    this.applyRank();
    this.state = new Uint8Array(this.L.N);
    this.mine = new Uint8Array(Math.ceil(this.L.N / 8));
    this.versions = { seatEpoch: 0, version: new Uint32Array(this.L.S) };
    this.cache.clear();
    if (snapshot) {
      const snap = decodeSnapshot(snapshot);
      if (snap.layoutVersion !== this.L.layoutVersion) throw new Error(`스냅샷 layoutVersion ${snap.layoutVersion} ≠ 좌석맵 ${this.L.layoutVersion}`);
      if ((snap.flags & 1) === 0 && snap.sections.length !== this.L.S) throw new Error(`전체 스냅샷 구역 수 ${snap.sections.length} ≠ 좌석맵 ${this.L.S}`);
      applySnapshot(this.state, snap, (s) => (s < this.L.S ? [this.L.sectionStart[s]!, this.L.sectionEnd[s]!] : undefined));
      this.versions.seatEpoch = snap.seatEpoch;
      for (const s of snap.sections) this.versions.version[s.sectionIndex] = s.sectionVersion;
      this.hasState = true;
    }
    this.fitAll();
  }

  resize(width: number, height: number, dpr: number): void {
    const v = this.L ? this.viewRect() : null;
    this.o = { ...this.o, width, height, dpr };
    this.cache.clear();
    // 화면 크기가 바뀌면 지금 보던 가운데를 그대로 두고 배율·이동을 다시 묶는다
    if (v) this.place(this.cam.scale, v.x + v.w / 2, v.y + v.h / 2, width / 2, height / 2);
  }

  /** 델타 묶음을 반영하고, 바뀐 구역의 비트맵을 버린다(§4.4 적용 순서는 wire.applyDelta) */
  applyDelta(frame: Extract<Frame, { type: 'delta' }>): DeltaDecision {
    const d = applyDelta(this.state, this.versions, frame, this.L.sectionStart, this.L.sectionEnd);
    if (d.kind === 'apply') for (const s of d.sections) this.cache.invalidate(s);
    else this.cache.clear();
    return d;
  }

  /** 구역 하나의 스냅샷을 반영한다(갭·세대 다시 맞추기, §4.4.1). 그 구역의 비트맵만 버린다 */
  applySectionSnapshot(snap: Snapshot): void {
    if (snap.layoutVersion !== this.L.layoutVersion) throw new Error(`스냅샷 layoutVersion ${snap.layoutVersion} ≠ 좌석맵 ${this.L.layoutVersion}`);
    const head = snap.sections[0];
    if ((snap.flags & 1) === 0 || snap.sections.length !== 1 || !head || head.sectionIndex >= this.L.S) throw new Error('구역 하나의 스냅샷이 아니다');
    const from = this.L.sectionStart[head.sectionIndex]!;
    const to = this.L.sectionEnd[head.sectionIndex]!;
    const before = this.state.slice(from, to + 1);
    applySnapshot(this.state, snap, (s) => (s < this.L.S ? [this.L.sectionStart[s]!, this.L.sectionEnd[s]!] : undefined));
    // 스냅샷의 점유는 '선택 불가'뿐이다. 이미 아는 값(다른 분 선택·판매)은 지키고, 내 좌석은 내 표시가 남게 다른 분 선택으로 둔다(서버도 내 홀드를 홀드로 보낸다)
    for (let k = from; k <= to; k++) {
      if (this.state[k] !== STATE.UNAVAILABLE) continue;
      const was = before[k - from]!;
      if (was === STATE.HELD || was === STATE.SOLD) this.state[k] = was;
      else if (this.isMine(k)) this.state[k] = STATE.HELD;
    }
    this.versions.seatEpoch = Math.max(this.versions.seatEpoch, snap.seatEpoch);
    this.versions.version[head.sectionIndex] = head.sectionVersion;
    this.cache.invalidate(head.sectionIndex);
  }

  setTheme(theme: ColorMode): void {
    this.o.theme = theme;
    this.cache.clear();
  }

  // ── 카메라 ──────────────────────────────────────────────

  private fitScale(): number {
    const c = this.L.file.canvas;
    return cameraFit(this.o.width, this.o.height, c.minX, c.minY, c.width, c.height).scale;
  }

  /** 전체가 맞는 배율 대비 지금 배율 */
  zoom(): number {
    return this.cam.scale / this.fitScale();
  }

  /** 더 확대할 수 없는 배율(전체가 맞는 배율 대비) */
  maxZoom(): number {
    return this.maxScale() / this.fitScale();
  }

  private maxScale(): number {
    return MAX_SEAT_PX / (SEAT_CM * 0.8);
  }

  /**
   * 세계 좌표 (wx, wy)를 화면 (sx, sy)에 두고 배율을 정한다. 배율은 전체가 맞는 배율 ~ 가장 큰 배율 사이로, 이동은 배치가 화면보다 작은 방향은
   * 가운데로, 큰 방향은 배치 밖 빈 곳이 보이지 않게 묶는다(끝까지 축소하면 [전체 보기]와 같다)
   */
  private place(scale: number, wx: number, wy: number, sx: number, sy: number): void {
    const s = Math.min(this.maxScale(), Math.max(this.fitScale(), scale));
    const c = this.L.file.canvas;
    const clamp = (t: number, min: number, size: number, view: number) => {
      const content = size * s;
      if (content <= view) return (view - content) / 2 - min * s;
      return Math.min(-min * s, Math.max(view - (min + size) * s, t));
    };
    this.cam = { scale: s, tx: clamp(sx - wx * s, c.minX, c.width, this.o.width), ty: clamp(sy - wy * s, c.minY, c.height, this.o.height) };
  }

  /** [전체 보기] */
  fitAll(): void {
    const c = this.L.file.canvas;
    this.cam = cameraFit(this.o.width, this.o.height, c.minX, c.minY, c.width, c.height);
  }

  /** zoom 배율(1 = 전체가 맞는 배율)과 세계 좌표 중심 */
  setCamera(zoom: number, cx: number, cy: number): void {
    this.place(this.fitScale() * zoom, cx, cy, this.o.width / 2, this.o.height / 2);
  }

  /** [+]·[−]·휠·핀치: 화면 점(기본은 가운데)을 그대로 두고 factor배 */
  zoomBy(factor: number, sx = this.o.width / 2, sy = this.o.height / 2): void {
    const wx = (sx - this.cam.tx) / this.cam.scale;
    const wy = (sy - this.cam.ty) / this.cam.scale;
    this.place(this.cam.scale * factor, wx, wy, sx, sy);
  }

  /** 등급 차례·이름을 바꾼다(회차 가격표가 첫 그림보다 늦게 올 때). 구역 면 색이 바뀌므로 비트맵을 버린다 */
  setTiers(tierRank?: readonly string[], tierNames?: Readonly<Record<string, string>>): void {
    if (tierRank) this.o.tierRank = tierRank;
    if (tierNames) this.o.tierNames = tierNames;
    this.applyRank();
    this.cache.clear();
  }

  /** 끌기: 화면 px만큼 옮긴다(배율은 그대로, place가 배치 밖 빈 곳이 보이지 않게 묶는다) */
  panBy(dx: number, dy: number): void {
    const { scale, tx, ty } = this.cam;
    this.place(scale, -tx / scale, -ty / scale, dx, dy);
  }

  /** 구역 하나를 화면에 맞춘다(그 구역이 화면 폭의 1/3 이상이 되어 좌석 단계로 간다) */
  focusSection(s: number): void {
    const b = this.L.bounds.subarray(s * 4, s * 4 + 4);
    const pad = 200;
    const fit = cameraFit(this.o.width, this.o.height, b[0]! - pad, b[1]! - pad, b[2]! - b[0]! + pad * 2, b[3]! - b[1]! + pad * 2);
    this.place(fit.scale, (b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2, this.o.width / 2, this.o.height / 2);
  }

  /** 화면에 보이는 세계 범위 */
  viewRect(): { x: number; y: number; w: number; h: number } {
    const { scale, tx, ty } = this.cam;
    return { x: -tx / scale, y: -ty / scale, w: this.o.width / scale, h: this.o.height / scale };
  }

  private sectionVisible(s: number): boolean {
    const v = this.viewRect();
    const b = this.L.bounds;
    return !(b[s * 4 + 2]! < v.x || b[s * 4]! > v.x + v.w || b[s * 4 + 3]! < v.y || b[s * 4 + 1]! > v.y + v.h);
  }

  level(): Level {
    if (!this.hasState) return 'loading';
    for (let s = 0; s < this.L.S; s++) {
      if (!this.sectionVisible(s)) continue;
      const w = (this.L.bounds[s * 4 + 2]! - this.L.bounds[s * 4]! + SEAT_CM) * this.cam.scale;
      if (w >= this.o.width * SEATS_SECTION_RATIO) return 'seats';
    }
    return 'overview';
  }

  // ── 좌석 ────────────────────────────────────────────────

  /** 방금 놓은 좌석 → 다시 고를 수 있는 시각(벽시계 ms) */
  readonly released = new Map<number, number>();
  /** 좌석 ID → 색인(처음 부를 때 만든다) */
  #idIndex: Map<string, number> | undefined;

  seatIndexOf(seatId: string): number {
    if (!this.#idIndex) {
      this.#idIndex = new Map();
      for (let s = 0; s < this.L.S; s++) {
        const ids = this.L.seatIds[s]!;
        for (let i = 0; i < ids.length; i++) this.#idIndex.set(ids[i]!, this.L.sectionStart[s]! + i);
      }
    }
    return this.#idIndex.get(seatId) ?? -1;
  }

  /** 방금 놓은 좌석을 더한다. 바뀐 구역 그림을 지운다 */
  markReleased(seatId: string, untilMs: number): void {
    const k = this.seatIndexOf(seatId);
    if (k < 0) return;
    this.released.set(k, untilMs);
    this.cache.invalidate(sectionOf(this.L, k).section);
  }

  isRecentlyReleased(k: number, nowMs: number): boolean {
    const until = this.released.get(k);
    return until !== undefined && until > nowMs;
  }

  /** 지난 항목을 지우고 다음에 풀릴 시각을 돌려준다(없으면 undefined) */
  pruneReleased(nowMs: number): number | undefined {
    let next: number | undefined;
    for (const [k, until] of this.released) {
      if (until <= nowMs) {
        this.released.delete(k);
        this.cache.invalidate(sectionOf(this.L, k).section);
      } else if (next === undefined || until < next) next = until;
    }
    return next;
  }

  /** 내 좌석 표시를 켜거나 끈다(이미 그 상태면 그대로) */
  setMine(seatId: string, on: boolean): void {
    const k = this.seatIndexOf(seatId);
    if (k >= 0 && this.isMine(k) !== on) this.toggleMine(k);
  }

  isMine(k: number): boolean {
    return ((this.mine[k >> 3]! >> (k & 7)) & 1) === 1;
  }

  toggleMine(k: number): void {
    this.mine[k >> 3]! ^= 1 << (k & 7);
    this.cache.invalidate(sectionOf(this.L, k).section);
  }

  /** 지금 배율에서 좌석 한 변(CSS px) */
  seatPx(): number {
    return SEAT_CM * this.cam.scale * 0.8;
  }

  /** 좌석을 고를 수 있는 배율인가(좌석 단계이고 24 CSS px 이상) */
  selectable(): boolean {
    return this.level() === 'seats' && this.seatPx() >= MIN_SELECT_PX;
  }

  /** 고를 수 있는 좌석인가: 가능 상태이고 판매 제외가 아니다(이미 고른 좌석은 풀 수 있다) */
  canSelect(k: number): boolean {
    if (k < 0 || k >= this.L.N) return false;
    if (this.isMine(k)) return true;
    if (this.isRecentlyReleased(k, Date.now())) return false;
    return this.state[k] === STATE.AVAILABLE && ((this.L.attr[k]! >> 4) & FLAG.EXCLUDED) === 0;
  }

  /** 화면 점 → 좌석(없거나 고를 수 없는 배율이면 -1)과 ID·표시 이름·등급 */
  /** 미니맵 상자(CSS px). 좌석 단계에서만 그린다 */
  minimapRect(): { x: number; y: number; w: number; h: number } {
    const c = this.L.file.canvas;
    const w = MINIMAP.width;
    const h = (w * c.height) / c.width;
    return { x: this.o.width - w - MINIMAP.margin, y: this.o.height - h - MINIMAP.margin, w, h };
  }

  /** 화면 점의 좌석(없으면 -1). 미니맵에 가려진 좌석은 없는 것으로 본다 */
  private seatAt(px: number, py: number): number {
    const m = this.minimapRect();
    const onMinimap = px >= m.x && px <= m.x + m.w && py >= m.y && py <= m.y + m.h;
    return onMinimap ? -1 : hitAtScreen(this.L, this.grids, this.cam, px, py);
  }

  /** 화면 점의 고를 수 있는 좌석을 마우스 올림 좌석으로 둔다. 바뀌었으면 true */
  hoverAt(px: number, py: number): boolean {
    const k = this.selectable() ? this.seatAt(px, py) : -1;
    const next = k >= 0 && this.canSelect(k) ? k : -1;
    if (next === this.hovered) return false;
    this.hovered = next;
    return true;
  }

  /** 마우스 올림 표시를 지운다. 바뀌었으면 true */
  clearHover(): boolean {
    if (this.hovered < 0) return false;
    this.hovered = -1;
    return true;
  }

  /** 좌석이 보이지만 고를 수 없는 배율에서 좌석을 눌렀으면 그 점을 고정해 고를 수 있는 배율로 확대한다. 확대했으면 true(ADR-0236) */
  zoomToSeat(px: number, py: number): boolean {
    if (this.level() !== 'seats' || this.selectable() || this.seatPx() < SEAT_DRAW_MIN_PX || this.seatAt(px, py) < 0) return false;
    this.zoomBy(SELECT_ZOOM_PX / this.seatPx(), px, py);
    return true;
  }

  hit(px: number, py: number): { seatIndex: number; seatId: string | null; label: string | null; tier: string | null } {
    const k = this.selectable() ? this.seatAt(px, py) : -1;
    if (k < 0) return { seatIndex: -1, seatId: null, label: null, tier: null };
    const { section, offset } = sectionOf(this.L, k);
    const sec = this.L.file.sections[section]!;
    return { seatIndex: k, seatId: seatIdOf(this.L, k), label: `${sec.name} ${sec.seats.row[offset]}열 ${sec.seats.number[offset]}번`, tier: this.L.file.tiers[this.L.attr[k]! & 15]! };
  }

  /** 화면 점이 든 구역(없으면 -1). 전체 배치도에서 구역을 누르면 그 구역으로 확대한다 */
  sectionAt(px: number, py: number): number {
    const wx = (px - this.cam.tx) / this.cam.scale;
    const wy = (py - this.cam.ty) / this.cam.scale;
    for (let s = 0; s < this.L.S; s++) if (pointInPolygon(this.L.file.sections[s]!.shape.points, wx, wy)) return s;
    return -1;
  }

  // ── 그리기 ──────────────────────────────────────────────

  /** 지금 단계로 그린다. 그린 좌석 수(비트맵으로 그린 구역의 좌석 포함)를 돌려준다 */
  draw(): number {
    const lv = this.level();
    this.clear();
    if (lv !== 'seats') {
      this.drawSections(lv === 'loading' ? 'wireframe' : 'faces');
      return 0;
    }
    const drawn = this.drawSeats();
    this.drawMinimap();
    return drawn;
  }

  private clear(): void {
    const { ctx, width, height, dpr, theme } = this.o;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = overviewPalette(theme).bg;
    ctx.fillRect(0, 0, width * dpr, height * dpr);
  }

  private path(points: ReadonlyArray<readonly [number, number]>): void {
    const { ctx } = this.o;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  /**
   * 무대·구역. wireframe(loading): 외곽선만, 글자 없음. faces(overview): 등급 면과 글자(이름·등급·남은 상태).
   * outlines(seats): 좌석 밑에 구역 외곽선만(면을 깔면 가능 좌석과 바탕의 대비가 3:1에 못 미친다. 축소하면 다시 면으로 합쳐진다)
   */
  private drawSections(mode: 'wireframe' | 'faces' | 'outlines'): void {
    const wireframe = mode !== 'faces';
    const { ctx, dpr, theme } = this.o;
    const P = overviewPalette(theme);
    const { cam, L } = this;
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
    ctx.lineWidth = 1.5 / cam.scale;
    for (const st of L.file.stage) {
      this.path(st.points);
      ctx.strokeStyle = P.line;
      if (wireframe) ctx.stroke();
      else {
        ctx.fillStyle = P.stage;
        ctx.fill();
      }
    }
    for (let s = 0; s < L.S; s++) {
      this.path(L.file.sections[s]!.shape.points);
      const face = wireframe ? null : tierFace(this.rank[this.tiers[s]!]!, theme);
      if (face) {
        ctx.fillStyle = face;
        ctx.fill();
      }
      ctx.strokeStyle = P.line;
      ctx.stroke();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (mode !== 'faces') return;
    ctx.fillStyle = P.ink;
    ctx.font = '600 12px system-ui, sans-serif';
    for (let s = 0; s < L.S; s++) {
      const sec = L.file.sections[s]!;
      const x = cam.tx + sec.label.x * cam.scale;
      const y = cam.ty + sec.label.y * cam.scale;
      // 등급 글자는 늘 함께 쓴다(면 색은 보조, WCAG 1.4.1). 상태는 스냅샷을 받은 뒤에만
      ctx.fillText(`${sec.name} ${this.tierLabel(s)}`, x - 20, y);
      ctx.fillText(STATUS_LABEL[sectionStatus(L, this.state, s).status], x - 20, y + 14);
    }
  }

  /** 좌석 단계: 보이는 구역의 좌석. 24px 미만이면 구역 비트맵을 늘려 그리고, 이상이면 보이는 좌석만 바로 그린다 */
  private drawSeats(): number {
    const { ctx, dpr, theme } = this.o;
    const { cam, L } = this;
    const seatPx = this.seatPx();
    const v = this.viewRect();
    const x0 = v.x - SEAT_CM;
    const y0 = v.y - SEAT_CM;
    const x1 = v.x + v.w + SEAT_CM;
    const y1 = v.y + v.h + SEAT_CM;
    let drawn = 0;
    // 구역 외곽선을 먼저 긋는다(좌석 사이 빈 곳에 구역 모양이 보이게, 면은 칠하지 않는다)
    this.drawSections('outlines');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (seatPx < SEAT_DRAW_MIN_PX) return 0;
    for (let s = 0; s < L.S; s++) {
      if (!this.sectionVisible(s)) continue;
      if (seatPx < MIN_SELECT_PX && this.o.bitmaps && this.drawSectionBitmap(s)) {
        drawn += L.sectionEnd[s]! - L.sectionStart[s]! + 1;
        continue;
      }
      for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) {
        const wx = L.x[k]!;
        const wy = L.y[k]!;
        if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
        this.paintSeat(ctx, k, cam.tx + wx * cam.scale, cam.ty + wy * cam.scale, seatPx, theme);
        drawn++;
      }
    }
    if (this.hovered >= 0 && seatPx >= MIN_SELECT_PX) this.drawHover(seatPx);
    return drawn;
  }

  /** 마우스를 올린 좌석을 다른 좌석 위에 키워 그리고 테두리를 두른다(ADR-0236) */
  private drawHover(seatPx: number): void {
    const { ctx, theme } = this.o;
    const { cam, L } = this;
    const k = this.hovered;
    const size = seatPx * HOVER_SCALE;
    const sx = cam.tx + L.x[k]! * cam.scale;
    const sy = cam.ty + L.y[k]! * cam.scale;
    this.paintSeat(ctx, k, sx, sy, size, theme);
    const inner = size + HOVER_GAP_PX;
    ctx.strokeStyle = overviewPalette(theme).bg;
    ctx.lineWidth = HOVER_GAP_PX;
    ctx.strokeRect(sx - inner / 2, sy - inner / 2, inner, inner);
    const outer = size + 2 * HOVER_GAP_PX + HOVER_RING_PX;
    ctx.strokeStyle = color[theme]['focus-ring'];
    ctx.lineWidth = HOVER_RING_PX;
    ctx.strokeRect(sx - outer / 2, sy - outer / 2, outer, outer);
  }

  private paintSeat(ctx: Ctx2D, k: number, sx: number, sy: number, size: number, theme: ColorMode): void {
    const st = seatStyle(seatState(this.state[k]!, this.L.attr[k]!, this.isMine(k), this.isRecentlyReleased(k, Date.now())), theme);
    const wheelchair = ((this.L.attr[k]! >> 4) & FLAG.WHEELCHAIR) !== 0 && st.state !== 'wheelchair';
    drawSeat(ctx, st, sx, sy, size, wheelchair);
  }

  /** 구역 하나를 비트맵으로 그린다(없으면 만든다). 8MB를 넘어 만들 수 없으면 false */
  private drawSectionBitmap(s: number): boolean {
    const { ctx, dpr, theme } = this.o;
    const { cam, L } = this;
    const { bucket, scale } = scaleBucket(cam.scale);
    const b = L.bounds.subarray(s * 4, s * 4 + 4);
    const pad = SEAT_CM;
    const wCss = (b[2]! - b[0]! + pad * 2) * scale;
    const hCss = (b[3]! - b[1]! + pad * 2) * scale;
    let bmp = this.cache.get(s, bucket);
    if (!bmp) {
      const w = Math.ceil(wCss * dpr);
      const h = Math.ceil(hCss * dpr);
      if (w * h * 4 > this.cache.maxEntryBytes) return false;
      const made = this.o.bitmaps!.create(w, h);
      made.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = SEAT_CM * scale * 0.8;
      for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) {
        this.paintSeat(made.ctx, k, (L.x[k]! - b[0]! + pad) * scale, (L.y[k]! - b[1]! + pad) * scale, size, theme);
      }
      const fin = made.finish();
      bmp = { image: fin.image, close: fin.close, scale, bytes: w * h * 4 };
      this.cache.set(s, bucket, bmp);
    }
    const k = cam.scale / bmp.scale;
    (ctx as ImageCtx).drawImage(bmp.image, cam.tx + (b[0]! - pad) * cam.scale, cam.ty + (b[1]! - pad) * cam.scale, wCss * k, hCss * k);
    return true;
  }

  /** 미니맵: 전체 배치의 구역 외곽선과 지금 보는 범위 사각형(오른쪽 아래) */
  private drawMinimap(): void {
    const { ctx, width, height, dpr, theme } = this.o;
    const P = overviewPalette(theme);
    const c = this.L.file.canvas;
    const { x: ox, y: oy, w, h } = this.minimapRect();
    const s = w / c.width;
    void width;
    void height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.bg;
    ctx.fillRect(ox, oy, w, h);
    ctx.strokeStyle = P.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, w, h);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox - c.minX * s), dpr * (oy - c.minY * s));
    ctx.lineWidth = 1 / s;
    for (const sec of this.L.file.sections) {
      this.path(sec.shape.points);
      ctx.stroke();
    }
    // 지금 보는 범위(배치 캔버스 안으로 잘라 미니맵 상자 밖에 그리지 않는다)
    const v = this.viewRect();
    const x0 = Math.max(v.x, c.minX);
    const y0 = Math.max(v.y, c.minY);
    const x1 = Math.min(v.x + v.w, c.minX + c.width);
    const y1 = Math.min(v.y + v.h, c.minY + c.height);
    ctx.strokeStyle = P.text;
    ctx.lineWidth = 2 / s;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}
