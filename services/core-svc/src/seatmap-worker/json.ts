// 좌석맵 JSON 읽기(ADR-0257 결정 6·7, docs/security/asvs/seat-hold.md 1.5.2·5.2.2).
// 계약 SeatMapLayoutInput(정의 밖 칸을 받지 않는 요청용 스키마) Zod로 본다. __proto__·constructor·prototype 키는 받지 않는다.
// JSON으로 읽히지 않거나 스키마와 다르면 형식 불일치(FORMAT_MISMATCH)다. 이름 정리와 길이·개수 상한은 배치 모으기가 한다.
// 모델 하나만 싣는다(작업 스레드는 요청마다 새로 뜨므로 계약 모델 전체를 싣지 않는다)
import { SeatMapLayoutInput } from '@peaket/contracts/openapi/model/seatMapLayoutInput.zod';
import { LayoutBuilder, Rejected, type ParsedLayout } from './layout-builder.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseStrict(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error('원형 오염 키');
    return value;
  });
}

/** JSON 글 → 배치. 해석하지 않는 파일이면 Rejected를 던진다 */
export function readJson(text: string): { layout: ParsedLayout; builder: LayoutBuilder } {
  let raw: unknown;
  try {
    raw = parseStrict(text);
  } catch {
    throw new Rejected('FORMAT_MISMATCH', 0, 'json');
  }
  const r = SeatMapLayoutInput.safeParse(raw);
  if (!r.success) throw new Rejected('FORMAT_MISMATCH', 0, r.error.issues[0]?.path.join('.') ?? 'json');
  const doc = r.data;
  const b = new LayoutBuilder({ sameNameOk: true });
  for (const s of doc.stage ?? []) b.addStage({ kind: s.kind, points: s.points as [number, number][], ...(s.name !== undefined ? { name: s.name } : {}) }, 0);
  doc.sections.forEach((s, at) => {
    b.addSection(s.name, { kind: s.shape.kind, points: s.shape.points as [number, number][], ...(s.shape.name !== undefined ? { name: s.shape.name } : {}) }, 0, {
      sectionId: s.sectionId,
      ...(s.label ? { label: s.label } : {}),
      ...(s.tierId !== undefined ? { tierId: s.tierId } : {}),
      ...(s.gateZone !== undefined ? { gateZone: s.gateZone } : {}),
      ...(s.level !== undefined ? { level: s.level } : {}),
      ...(s.seatIndexRange ? { seatIndexRange: s.seatIndexRange } : {}),
      ...(s.fillRule ? { fillRule: s.fillRule } : {}),
    });
    for (const seat of s.seats ?? []) {
      b.addSeat({
        line: 0,
        section: s.name,
        at,
        seatId: seat.seatId,
        row: seat.row,
        number: String(seat.number),
        x: seat.x,
        y: seat.y,
        ...(seat.index !== undefined ? { index: seat.index } : {}),
        ...(seat.tierId !== undefined ? { tierId: seat.tierId } : {}),
        ...(seat.wheelchair !== undefined ? { wheelchair: seat.wheelchair } : {}),
        ...(seat.unavailable !== undefined ? { unavailable: seat.unavailable } : {}),
        ...(seat.gateZone !== undefined ? { gateZone: seat.gateZone } : {}),
      });
    }
  });
  return { layout: b.finish(doc.canvas), builder: b };
}
