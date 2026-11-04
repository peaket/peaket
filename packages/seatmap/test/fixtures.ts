// 시험용 좌석맵 파일과 이진 자료를 만든다(BUILD_ORDER HOT-110). 구역 둘레가 맞닿게 두어 경계의 누른 좌석 찾기를 본다.
import { LAYOUT_FORMAT, type SeatMapColumnsFile } from '../src/layout';

export function makeLayout(opts: { sections?: number; rows?: number; perRow?: number; gap?: number; jitter?: boolean } = {}): SeatMapColumnsFile {
  const { sections = 4, rows = 10, perRow = 20, gap = 60, jitter = true } = opts;
  const pitch = 55; // 좌석 간격 55cm
  const out: SeatMapColumnsFile = {
    format: LAYOUT_FORMAT,
    layoutVersion: 3,
    // 흔들림(±5cm)과 겹친 구역(gap < 0)도 캔버스 안에 들게 여백을 둔다
    canvas: { minX: -100, minY: 0, width: sections * (perRow * pitch + Math.max(gap, 0)) + 300, height: rows * pitch + 500 },
    stage: [{ kind: 'RECT', points: [[0, 0], [sections * (perRow * pitch + gap), 0], [sections * (perRow * pitch + gap), 200], [0, 200]] }],
    tiers: ['VIP', 'R', 'S'],
    seatCount: 0,
    sections: [],
  };
  let next = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) % 1000) / 1000;
  for (let s = 0; s < sections; s++) {
    const x0 = s * (perRow * pitch + gap);
    const c = { seatId: [] as string[], row: [] as string[], number: [] as string[], x: [] as number[], y: [] as number[], tier: [] as number[], flags: [] as number[] };
    for (let r = 0; r < rows; r++) {
      for (let n = 0; n < perRow; n++) {
        c.seatId.push(`S${s}-R${r}-${n}`);
        c.row.push(String(r + 1));
        c.number.push(String(n + 1));
        c.x.push(x0 + n * pitch + (jitter ? Math.round(rnd() * 10 - 5) : 0));
        c.y.push(300 + r * pitch + (jitter ? Math.round(rnd() * 10 - 5) : 0));
        c.tier.push(s % 3);
        c.flags.push(r === 0 && n < 2 ? 1 : r === rows - 1 && n === perRow - 1 ? 2 : 0);
      }
    }
    const n = rows * perRow;
    out.sections.push({
      sectionId: `S${s}`,
      name: `${s + 1}구역`,
      shape: { kind: 'RECT', points: [[x0, 280], [x0 + perRow * pitch, 280], [x0 + perRow * pitch, 300 + rows * pitch], [x0, 300 + rows * pitch]] },
      label: { x: x0 + (perRow * pitch) / 2, y: 260 },
      seatIndexRange: { from: next, to: next + n - 1 },
      seats: c,
    });
    next += n;
  }
  out.seatCount = next;
  return out;
}

/** 스냅샷 이진 자료(u8 version, u8 flags, u32 layoutVersion, u32 seatEpoch, u16 count, (u16, u32)*, 비트맵) */
export function encodeSnapshot(o: { flags?: number; layoutVersion: number; seatEpoch: number; sections: Array<[number, number]>; occupied: boolean[] }): Uint8Array {
  const bitmapBytes = Math.ceil(o.occupied.length / 8);
  const u8 = new Uint8Array(12 + o.sections.length * 6 + bitmapBytes);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, o.flags ?? 0);
  v.setUint32(2, o.layoutVersion, true);
  v.setUint32(6, o.seatEpoch, true);
  v.setUint16(10, o.sections.length, true);
  let p = 12;
  for (const [i, ver] of o.sections) {
    v.setUint16(p, i, true);
    v.setUint32(p + 2, ver, true);
    p += 6;
  }
  o.occupied.forEach((b, i) => {
    if (b) u8[p + (i >> 3)]! |= 1 << (i & 7);
  });
  return u8;
}

/** SeatDeltaBatch 프레임(type 1) */
export function encodeDelta(o: { serverTimeMs?: number; maxWaitMs?: number; seatEpoch: number; sections: Array<{ index: number; version: number; changes: Array<[number, number]> }> }): Uint8Array {
  const size = 18 + o.sections.reduce((a, s) => a + 8 + s.changes.length * 3, 0);
  const u8 = new Uint8Array(size);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 1);
  v.setBigUint64(2, BigInt(o.serverTimeMs ?? 1_700_000_000_000), true);
  v.setUint16(10, o.maxWaitMs ?? 100, true);
  v.setUint32(12, o.seatEpoch, true);
  v.setUint16(16, o.sections.length, true);
  let p = 18;
  for (const s of o.sections) {
    v.setUint16(p, s.index, true);
    v.setUint32(p + 2, s.version, true);
    v.setUint16(p + 6, s.changes.length, true);
    p += 8;
    for (const [off, st] of s.changes) {
      v.setUint16(p, off, true);
      v.setUint8(p + 2, st);
      p += 3;
    }
  }
  return u8;
}

/** 그리기 호출을 적는 가짜 2D 문맥 */
export function fakeCtx() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
  const ctx = {
    calls,
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 1,
    font: '',
    setTransform: rec('setTransform'),
    fillRect: (...a: unknown[]) => void calls.push(['fillRect', ctx.fillStyle, ...a]),
    strokeRect: (...a: unknown[]) => void calls.push(['strokeRect', ctx.strokeStyle, ...a]),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    fill: () => void calls.push(['fill', ctx.fillStyle]),
    stroke: () => void calls.push(['stroke', ctx.strokeStyle]),
    fillText: rec('fillText'),
    drawImage: rec('drawImage'),
  };
  return ctx;
}
