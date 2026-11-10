// 에디터 Worker 메시지(ADR-0264 결정 5). 메시지는 { id, type, … }이고 type은 fill·align·distribute·aisle·renumber·export(HOT-230에서 check)다.
// 좌석 배열은 열(좌표·번호·플래그는 형식 배열)로 묶어 Transferable로 넘긴다. 받은 쪽은 모양을 손으로 본다(Zod를 파트너 콘솔에 들이지 않는다, ADR-0264 결정 25).
import type { ExportFormat } from './export.ts';
import type { EditorDoc, FillRule, Pt, Seat, Section, Shape } from './types.ts';

export const REFINE_TYPES = ['align', 'distribute', 'aisle', 'renumber'] as const;
export type RefineType = (typeof REFINE_TYPES)[number];
export type JobType = 'fill' | RefineType | 'export';

/** 좌석 열 묶음 */
export interface PackedSeats {
  ids: string[];
  rows: string[];
  numbers: Int32Array;
  xs: Int32Array;
  ys: Int32Array;
  /** 1 휠체어석, 2 판매 제외 */
  flags: Uint8Array;
  tiers: (string | null)[];
  gates: (string | null)[];
}

export interface PackedSection {
  section: Omit<Section, 'seats'>;
  seats: PackedSeats;
}

export function packSeats(seats: readonly Seat[]): PackedSeats {
  const n = seats.length;
  const p: PackedSeats = { ids: new Array(n), rows: new Array(n), numbers: new Int32Array(n), xs: new Int32Array(n), ys: new Int32Array(n), flags: new Uint8Array(n), tiers: new Array(n), gates: new Array(n) };
  seats.forEach((x, i) => {
    p.ids[i] = x.seatId;
    p.rows[i] = x.row;
    p.numbers[i] = x.number;
    p.xs[i] = x.x;
    p.ys[i] = x.y;
    p.flags[i] = (x.wheelchair ? 1 : 0) | (x.unavailable ? 2 : 0);
    p.tiers[i] = x.tierId ?? null;
    p.gates[i] = x.gateZone ?? null;
  });
  return p;
}

export function unpackSeats(p: PackedSeats): Seat[] {
  const out: Seat[] = new Array(p.ids.length);
  for (let i = 0; i < p.ids.length; i++) {
    const f = p.flags[i]!;
    const tier = p.tiers[i];
    const gate = p.gates[i];
    out[i] = {
      seatId: p.ids[i]!,
      row: p.rows[i]!,
      number: p.numbers[i]!,
      x: p.xs[i]!,
      y: p.ys[i]!,
      ...(tier !== null && tier !== undefined ? { tierId: tier } : {}),
      ...(f & 1 ? { wheelchair: true as const } : {}),
      ...(f & 2 ? { unavailable: true as const } : {}),
      ...(gate !== null && gate !== undefined ? { gateZone: gate } : {}),
    };
  }
  return out;
}

export function packSection(s: Section): PackedSection {
  const { seats, ...section } = s;
  return { section, seats: packSeats(seats) };
}

export const unpackSection = (p: PackedSection): Section => ({ ...p.section, seats: unpackSeats(p.seats) });

/** 넘길 버퍼(같은 버퍼를 두 번 넘기지 않는다) */
export function buffersOf(packs: readonly PackedSeats[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const p of packs) for (const a of [p.numbers, p.xs, p.ys, p.flags]) out.add(a.buffer as ArrayBuffer);
  return [...out];
}

export type ToWorker =
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'fill'; shape: Pt[]; rule: FillRule; stage: Shape[]; canvas: { width: number; height: number } }
  | { id: number; type: RefineType; sections: PackedSection[]; ids: string[]; stage: Shape[]; canvas: { width: number; height: number } }
  | { id: number; type: 'export'; format: ExportFormat; doc: EditorDoc; productionId: string; version: number };

export interface FillReply {
  rows: string[];
  numbers: Int32Array;
  xs: Int32Array;
  ys: Int32Array;
  target: number;
  capacity: number;
}

export type FromWorker = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCanvas = (v: unknown) => isObj(v) && Number.isInteger(v.width) && Number.isInteger(v.height);

/** 받은 메시지의 모양(정한 type과 칸만) */
export function isToWorker(m: unknown): m is ToWorker {
  if (!isObj(m) || !Number.isSafeInteger(m.id)) return false;
  switch (m.type) {
    case 'cancel':
      return Number.isSafeInteger(m.target);
    case 'fill':
      return Array.isArray(m.shape) && isObj(m.rule) && Array.isArray(m.stage) && isCanvas(m.canvas);
    case 'align':
    case 'distribute':
    case 'aisle':
    case 'renumber':
      return Array.isArray(m.sections) && Array.isArray(m.ids) && m.ids.every((x) => typeof x === 'string') && Array.isArray(m.stage) && isCanvas(m.canvas);
    case 'export':
      return (m.format === 'JSON' || m.format === 'CSV' || m.format === 'SVG') && isObj(m.doc) && typeof m.productionId === 'string' && Number.isSafeInteger(m.version);
    default:
      return false;
  }
}

export function isFromWorker(m: unknown): m is FromWorker {
  return isObj(m) && Number.isSafeInteger(m.id) && typeof m.ok === 'boolean';
}
