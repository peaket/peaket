// 좌석맵 그리기 엔진(docs/frontend.md §5.2, §1.5 'OffscreenCanvas 2D' 행, BUILD_ORDER HOT-110). Worker와 메인 스레드 대체가 같은 코드를 쓴다
// (OffscreenCanvas가 없는 브라우저는 같은 그리기 모듈을 메인 스레드에서 돌린다, FE-T15).
// 첫 그림은 전체 배치도(무대·구역 도형과 구역의 남은 비율, §5.2 단계 5)다. 고를 수 있는 배율에서는 보이는 좌석만 바로 그린다.
// 두 단계 그리기의 배율 전환·미니맵·[전체 보기]·구역 비트맵 캐시는 BUILD_ORDER HOT-120에서 더한다.
import { buildGrids, cameraFit, hitAtScreen, type Camera, type SectionGrid } from './grid';
import { FLAG, decodeLayout, sectionOf, seatIdOf, type DecodedLayout, type SeatMapColumnsFile } from './layout';
import { drawSeat, seatState, seatStyle, type ColorMode, type Ctx2D } from './paint';
import { applySnapshot, decodeSnapshot, STATE, type SectionVersions } from './wire';

/** 좌석 한 변(cm) [가정] */
export const SEAT_CM = 50;
/** 이 크기(CSS px) 이상이면 좌석을 그린다(그보다 작으면 전체 배치도) */
export const SEAT_DRAW_MIN_PX = 4;
/** 좌석을 고를 수 있는 가장 작은 크기(CSS px, §5.11·CMP-021 minSeatPx). 그보다 작으면 누른 좌석이 없다 */
export const MIN_SELECT_PX = 24;

/** 전체 배치도 구역 면: 남은 비율 경계는 아직 정하지 않았다(d5 §6 33번) [가정]. 등급 색(heat)·무늬로 바꾸는 일은 HOT-120(두 단계 그리기) */
const OVERVIEW = {
  light: { stage: '#1b1d22', plenty: '#cfe9d8', few: '#f4e2b8', none: '#e3e5e8', line: '#5b606a', text: '#1b1d22', bg: '#ffffff' },
  dark: { stage: '#e6e7ea', plenty: '#1e3b2f', few: '#3d3320', none: '#26292e', line: '#9aa0aa', text: '#e6e7ea', bg: '#16171b' },
} as const;

export interface EngineOptions {
  ctx: Ctx2D;
  width: number;
  height: number;
  dpr: number;
  theme: ColorMode;
}

export class SeatMapEngine {
  L!: DecodedLayout;
  grids!: SectionGrid[];
  state!: Uint8Array;
  /** 내가 고른 좌석(비트 배열, ⌈N/8⌉) */
  mine!: Uint8Array;
  versions!: SectionVersions;
  cam: Camera = { scale: 1, tx: 0, ty: 0 };
  private o: EngineOptions;

  constructor(o: EngineOptions) {
    this.o = { ...o };
  }

  load(file: SeatMapColumnsFile, snapshot?: ArrayBuffer | Uint8Array): void {
    this.L = decodeLayout(file);
    this.grids = buildGrids(this.L);
    this.state = new Uint8Array(this.L.N);
    this.mine = new Uint8Array(Math.ceil(this.L.N / 8));
    this.versions = { seatEpoch: 0, version: new Uint32Array(this.L.S) };
    if (snapshot) {
      const snap = decodeSnapshot(snapshot);
      if (snap.layoutVersion !== this.L.layoutVersion) throw new Error(`스냅샷 layoutVersion ${snap.layoutVersion} ≠ 좌석맵 ${this.L.layoutVersion}`);
      if ((snap.flags & 1) === 0 && snap.sections.length !== this.L.S) throw new Error(`전체 스냅샷 구역 수 ${snap.sections.length} ≠ 좌석맵 ${this.L.S}`);
      applySnapshot(this.state, snap, (s) => (s < this.L.S ? [this.L.sectionStart[s]!, this.L.sectionEnd[s]!] : undefined));
      this.versions.seatEpoch = snap.seatEpoch;
      for (const s of snap.sections) this.versions.version[s.sectionIndex] = s.sectionVersion;
    }
    const c = file.canvas;
    this.cam = cameraFit(this.o.width, this.o.height, c.minX, c.minY, c.width, c.height);
  }

  resize(width: number, height: number, dpr: number): void {
    this.o = { ...this.o, width, height, dpr };
  }

  setTheme(theme: ColorMode): void {
    this.o.theme = theme;
  }

  /** zoom 배율(1 = 전체가 맞는 배율)과 세계 좌표 중심 */
  setCamera(zoom: number, cx: number, cy: number): void {
    const c = this.L.file.canvas;
    const fit = cameraFit(this.o.width, this.o.height, c.minX, c.minY, c.width, c.height);
    const scale = fit.scale * zoom;
    this.cam = { scale, tx: this.o.width / 2 - cx * scale, ty: this.o.height / 2 - cy * scale };
  }

  isMine(k: number): boolean {
    return ((this.mine[k >> 3]! >> (k & 7)) & 1) === 1;
  }

  toggleMine(k: number): void {
    this.mine[k >> 3]! ^= 1 << (k & 7);
  }

  /** 지금 배율에서 좌석 한 변(CSS px) */
  seatPx(): number {
    return SEAT_CM * this.cam.scale * 0.8;
  }

  /** 좌석을 고를 수 있는 배율인가(24 CSS px 이상) */
  selectable(): boolean {
    return this.seatPx() >= MIN_SELECT_PX;
  }

  /** 고를 수 있는 좌석인가: 가능 상태이고 판매 제외가 아니다(이미 고른 좌석은 풀 수 있다) */
  canSelect(k: number): boolean {
    if (k < 0 || k >= this.L.N) return false;
    if (this.isMine(k)) return true;
    return this.state[k] === STATE.AVAILABLE && ((this.L.attr[k]! >> 4) & FLAG.EXCLUDED) === 0;
  }

  /** 화면 점 → 좌석(없거나 고를 수 없는 배율이면 -1)과 ID·표시 이름·등급 */
  hit(px: number, py: number): { seatIndex: number; seatId: string | null; label: string | null; tier: string | null } {
    const k = this.selectable() ? hitAtScreen(this.L, this.grids, this.cam, px, py) : -1;
    if (k < 0) return { seatIndex: -1, seatId: null, label: null, tier: null };
    const { section, offset } = sectionOf(this.L, k);
    const sec = this.L.file.sections[section]!;
    return { seatIndex: k, seatId: seatIdOf(this.L, k), label: `${sec.name} ${sec.seats.row[offset]}열 ${sec.seats.number[offset]}번`, tier: this.L.file.tiers[this.L.attr[k]! & 15]! };
  }

  /** 지금 카메라로 그린다. 좌석이 SEAT_DRAW_MIN_PX보다 작으면 전체 배치도, 아니면 보이는 좌석. 그린 좌석 수를 돌려준다 */
  draw(): number {
    const seatPx = this.seatPx();
    return seatPx < SEAT_DRAW_MIN_PX ? (this.drawOverview(), 0) : this.drawSeats(seatPx);
  }

  private clear(): void {
    const { ctx, width, height, dpr, theme } = this.o;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = OVERVIEW[theme].bg;
    ctx.fillRect(0, 0, width * dpr, height * dpr);
  }

  /** 전체 배치도: 무대·구역 도형과 구역 상태(남은 비율)만 */
  drawOverview(): void {
    const { ctx, dpr, theme } = this.o;
    const P = OVERVIEW[theme];
    const { cam, L } = this;
    this.clear();
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
    ctx.fillStyle = P.stage;
    for (const st of L.file.stage) {
      ctx.beginPath();
      st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
    }
    for (let s = 0; s < L.S; s++) {
      // 판매 제외 좌석은 남은 좌석에도 전체에도 세지 않는다
      let free = 0;
      let sellable = 0;
      for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) {
        if ((L.attr[k]! >> 4) & FLAG.EXCLUDED) continue;
        sellable++;
        if (this.state[k] === STATE.AVAILABLE) free++;
      }
      const ratio = sellable ? free / sellable : 0;
      ctx.fillStyle = ratio > 0.5 ? P.plenty : ratio > 0.1 ? P.few : P.none;
      ctx.strokeStyle = P.line;
      ctx.lineWidth = 2 / (dpr * cam.scale);
      ctx.beginPath();
      L.file.sections[s]!.shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = P.text;
    ctx.font = '600 12px system-ui, sans-serif';
    for (const sec of L.file.sections) ctx.fillText(sec.name, cam.tx + sec.label.x * cam.scale - 14, cam.ty + sec.label.y * cam.scale + 4);
  }

  /** 화면에 보이는 좌석만 그린다 */
  drawSeats(seatPx: number): number {
    const { ctx, width, height, dpr, theme } = this.o;
    const { cam, L } = this;
    this.clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x0 = -cam.tx / cam.scale - SEAT_CM;
    const y0 = -cam.ty / cam.scale - SEAT_CM;
    const x1 = x0 + width / cam.scale + SEAT_CM * 2;
    const y1 = y0 + height / cam.scale + SEAT_CM * 2;
    let drawn = 0;
    for (let s = 0; s < L.S; s++) {
      if (L.bounds[s * 4 + 2]! < x0 || L.bounds[s * 4]! > x1 || L.bounds[s * 4 + 3]! < y0 || L.bounds[s * 4 + 1]! > y1) continue;
      for (let k = L.sectionStart[s]!; k <= L.sectionEnd[s]!; k++) {
        const wx = L.x[k]!;
        const wy = L.y[k]!;
        if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
        const st = seatStyle(seatState(this.state[k]!, L.attr[k]!, this.isMine(k)), theme);
        const wheelchair = ((L.attr[k]! >> 4) & FLAG.WHEELCHAIR) !== 0 && st.state !== 'wheelchair';
        drawSeat(ctx, st, cam.tx + wx * cam.scale, cam.ty + wy * cam.scale, seatPx, wheelchair);
        drawn++;
      }
    }
    return drawn;
  }
}
