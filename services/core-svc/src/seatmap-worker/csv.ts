// 좌석맵 CSV 읽기(ADR-0257 결정 7, docs/features/seat-hold.md §10).
// - 첫 줄은 머리 section,row,number,x,y,tier,wheelchair,gate,shape(순서대로)다. 다르면 FORMAT_MISMATCH.
// - 좌석 한 줄이 한 행이고, 구역의 첫 행만 shape에 꼭짓점 'x y;x y;…'를 적는다. 따옴표 칸(RFC 4180)을 읽는다.
// - 글자 정리(NFC·제어 문자 지우기)와 길이 상한은 배치 모으기(layout-builder)가 한다.
import type { Point } from '../modules/catalog/domain/seatmap-import.js';
import { coord, LayoutBuilder, Rejected, type ParsedLayout } from './layout-builder.js';
import { cleanLabel } from './text.js';

export const CSV_HEADER = ['section', 'row', 'number', 'x', 'y', 'tier', 'wheelchair', 'gate', 'shape'] as const;

interface Record {
  line: number;
  fields: string[];
  /** 따옴표 밖에 따옴표가 있었다 */
  broken: boolean;
}

/** RFC 4180 칸 나누기. 줄 끝은 CRLF·LF. 닫지 않은 따옴표로 끝나면 FORMAT_MISMATCH */
function* records(text: string): Generator<Record> {
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const start = line;
    const fields: string[] = [];
    let broken = false;
    let field = '';
    let quoted = false;
    /** 방금 따옴표 칸을 닫았다(다음 글자는 쉼표·줄바꿈·끝이어야 한다) */
    let closed = false;
    let atFieldStart = true;
    for (;;) {
      if (i >= text.length) {
        if (quoted) throw new Rejected('FORMAT_MISMATCH', start, 'csv');
        fields.push(field);
        break;
      }
      const ch = text[i]!;
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          quoted = false;
          closed = true;
          i++;
          continue;
        }
        if (ch === '\n') line++;
        field += ch;
        i++;
        continue;
      }
      const ends = ch === ',' || ch === '\n' || (ch === '\r' && text[i + 1] === '\n');
      if (closed && !ends) broken = true;
      closed = false;
      if (ch === '"') {
        if (atFieldStart) quoted = true;
        else broken = true;
        atFieldStart = false;
        i++;
        continue;
      }
      if (ch === ',') {
        fields.push(field);
        field = '';
        atFieldStart = true;
        i++;
        continue;
      }
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 2;
        line++;
        fields.push(field);
        break;
      }
      if (ch === '\n') {
        i++;
        line++;
        fields.push(field);
        break;
      }
      field += ch;
      atFieldStart = false;
      i++;
    }
    yield { line: start, fields, broken };
  }
}

/** shape 칸 'x y;x y;…' */
function shapePoints(raw: string, line: number): Point[] | 'invalid' {
  const parts = raw.split(';').map((p) => p.trim()).filter((p) => p !== '');
  LayoutBuilder.checkPoints(parts.length, line, 'shape');
  const pts: Point[] = [];
  for (const p of parts) {
    const xy = p.split(/\s+/);
    if (xy.length !== 2) return 'invalid';
    const x = coord(xy[0]);
    const y = coord(xy[1]);
    if (x === undefined || y === undefined) return 'invalid';
    pts.push([x, y]);
  }
  return pts.length >= 3 ? pts : 'invalid';
}

const BOOL = new Map([
  ['', undefined],
  ['true', true],
  ['false', false],
]);

/** CSV 글 → 배치. 해석하지 않는 파일이면 Rejected를 던진다 */
export function readCsv(text: string): { layout: ParsedLayout; builder: LayoutBuilder } {
  const b = new LayoutBuilder();
  const it = records(text);
  const head = it.next();
  // 칸 단위로 견준다(따옴표 한 칸에 머리 전체를 넣은 줄은 머리가 아니다)
  if (head.done || head.value.broken || head.value.fields.length !== CSV_HEADER.length || head.value.fields.some((f, i) => f !== CSV_HEADER[i])) throw new Rejected('FORMAT_MISMATCH', 1, 'header');
  /** 이미 본 구역(정리한 이름으로 가린다. 제어 문자만 다른 두 이름은 같은 구역이다) */
  const seen = new Set<string>();
  for (const r of it) {
    if (r.fields.length === 1 && r.fields[0] === '') continue;
    if (r.broken) {
      b.countSeat(r.line);
      b.issue(r.line, 'csv', 'CSV_QUOTE');
      continue;
    }
    if (r.fields.length !== CSV_HEADER.length) {
      b.countSeat(r.line);
      b.issue(r.line, 'csv', 'COLUMN_COUNT');
      continue;
    }
    const [section, row, number, xs, ys, tier, wheel, gate, shape] = r.fields as [string, string, string, string, string, string, string, string, string];
    const key = cleanLabel(section);
    if (!seen.has(key)) {
      seen.add(key);
      const pts = shape.trim() === '' ? 'missing' : shapePoints(shape, r.line);
      if (pts === 'missing') b.issue(r.line, 'shape', 'SHAPE_MISSING');
      else if (pts === 'invalid') b.issue(r.line, 'shape', 'SHAPE_INVALID');
      else b.addSection(section, { kind: 'POLYGON', points: pts }, r.line);
    } else if (shape.trim() !== '') b.issue(r.line, 'shape', 'SHAPE_REPEATED');
    const x = coord(xs);
    const y = coord(ys);
    const wheelchair = BOOL.get(wheel.trim());
    if (x === undefined || y === undefined) {
      b.countSeat(r.line);
      b.issue(r.line, x === undefined ? 'x' : 'y', 'COORD_INVALID');
      continue;
    }
    if (!BOOL.has(wheel.trim())) {
      b.countSeat(r.line);
      b.issue(r.line, 'wheelchair', 'WHEELCHAIR_INVALID');
      continue;
    }
    b.addSeat({
      line: r.line,
      section,
      row,
      number,
      x,
      y,
      ...(tier !== '' ? { tierId: tier } : {}),
      ...(wheelchair !== undefined ? { wheelchair } : {}),
      ...(gate !== '' ? { gateZone: gate } : {}),
    });
  }
  return { layout: b.finish(), builder: b };
}
