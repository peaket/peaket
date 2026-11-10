// 좌석맵 JSON 읽기(ADR-0257 결정 6·7, docs/security/asvs/seat-hold.md 1.5.2·5.2.2).
// 계약 SeatMapLayoutInput(정의 밖 칸을 받지 않는 요청용 스키마) Zod로 본다. __proto__·constructor·prototype 키는 받지 않는다.
// JSON으로 읽히지 않거나 스키마와 다르면 형식 불일치(FORMAT_MISMATCH)다. 이름 정리와 길이·개수 상한은 배치 모으기가 한다.
// 부채꼴·곡선 띠의 손잡이 값(arc)은 관계가 맞을 때만 결과에 넘긴다(다시 가져와도 손잡이 값이 남는다, ADR-0264 결정 41).
// 모델 하나만 싣는다(작업 스레드는 요청마다 새로 뜨므로 계약 모델 전체를 싣지 않는다)
import { SeatMapLayoutInput } from '@peaket/contracts/openapi/model/seatMapLayoutInput.zod';
import { arcOk, type LayoutShape } from '../modules/catalog/domain/seatmap-import.js';
import { LayoutBuilder, Rejected, type ParsedLayout } from './layout-builder.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseStrict(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (FORBIDDEN_KEYS.has(key)) throw new Error('원형 오염 키');
    return value;
  });
}

type InShape = { kind: LayoutShape['kind']; points: unknown; name?: string | undefined; arc?: NonNullable<LayoutShape['arc']> | undefined };

/** 계약 도형 → 배치 도형(이름은 배치 모으기가 정리한다) */
function shapeOf(s: InShape): LayoutShape {
  const arc = s.arc !== undefined && arcOk({ kind: s.kind, arc: s.arc }) ? { arc: { ...s.arc } } : {};
  return { kind: s.kind, points: s.points as [number, number][], ...(s.name !== undefined ? { name: s.name } : {}), ...arc };
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
  for (const s of doc.stage ?? []) b.addStage(shapeOf(s), 0);
  doc.sections.forEach((s, at) => {
    b.addSection(s.name, shapeOf(s.shape), 0, {
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
