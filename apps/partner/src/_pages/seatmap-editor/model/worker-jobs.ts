// 에디터 Worker가 하는 일(ADR-0264 결정 5). 메시지 하나 → 답 하나. 계산은 fill.ts·refine.ts·export.ts의 순수 함수를 부르기만 한다.
// Worker 없이도 이 함수로 시험한다(asvs/frontend.md 15.1.3).
import { exportFile } from './export.ts';
import { fillSection } from './fill.ts';
import { alignRows, distributeRows, removeSeats, renumberRows } from './refine.ts';
import type { EditorDoc } from './types.ts';
import { buffersOf, type FillReply, type FromWorker, isToWorker, packSection, type PackedSection, unpackSection } from './worker-protocol.ts';

const REFINE = { align: alignRows, distribute: distributeRows, aisle: removeSeats, renumber: renumberRows } as const;

/** 메시지 하나를 처리한다. cancel은 답하지 않는다(undefined) */
export function runJob(m: unknown): { reply: FromWorker; transfer: ArrayBuffer[] } | undefined {
  if (!isToWorker(m)) {
    const id = typeof (m as { id?: unknown })?.id === 'number' ? (m as { id: number }).id : -1;
    return { reply: { id, ok: false, error: 'bad-message' }, transfer: [] };
  }
  try {
    switch (m.type) {
      case 'cancel':
        return undefined;
      case 'fill': {
        const r = fillSection(m.shape, m.rule, m.stage, m.canvas);
        const n = r.seats.length;
        const out: FillReply = { rows: r.seats.map((s) => s.row), numbers: new Int32Array(n), xs: new Int32Array(n), ys: new Int32Array(n), target: r.target, capacity: r.capacity };
        r.seats.forEach((s, i) => {
          out.numbers[i] = s.number;
          out.xs[i] = s.x;
          out.ys[i] = s.y;
        });
        return { reply: { id: m.id, ok: true, result: out }, transfer: [out.numbers.buffer as ArrayBuffer, out.xs.buffer as ArrayBuffer, out.ys.buffer as ArrayBuffer] };
      }
      case 'export': {
        const f = exportFile(m.doc, m.format, m.productionId, m.version);
        return { reply: { id: m.id, ok: true, result: f }, transfer: [] };
      }
      default: {
        const sections = m.sections.map(unpackSection);
        const doc: EditorDoc = { canvas: m.canvas, stage: m.stage, order: sections.map((s) => s.sectionId), sections: Object.fromEntries(sections.map((s) => [s.sectionId, s])), priceTiers: [] };
        const changes = REFINE[m.type](doc, new Set(m.ids));
        const packed: PackedSection[] = Object.values(changes).map(packSection);
        return { reply: { id: m.id, ok: true, result: packed }, transfer: buffersOf(packed.map((p) => p.seats)) };
      }
    }
  } catch {
    return { reply: { id: m.id, ok: false, error: 'failed' }, transfer: [] };
  }
}
