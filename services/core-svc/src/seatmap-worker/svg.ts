// 좌석맵 SVG의 제한된 읽개(ADR-0257 결정 6, docs/features/seat-hold.md §10, docs/security/asvs/seat-hold.md 1.3.4·1.5.1·1.3.6).
// XML 라이브러리를 쓰지 않는다. DTD를 지원하는 코드가 없으므로 외부 엔터티·엔터티 확장이 생기지 않고, 파일 안의 주소를 부르는 코드도 없다.
// - <!DOCTYPE·<!ENTITY가 있으면 해석하지 않는다(DOCTYPE_PRESENT). 루트가 svg가 아니거나 짝이 맞지 않으면 FORMAT_MISMATCH다.
// - 미리 정한 다섯 엔터티(&lt; &gt; &amp; &quot; &apos;)와 숫자 문자 참조만 푼다. 다른 &이름;과 홀로 쓴 &는 FORMAT_MISMATCH다.
// - 들어가는 묶음 요소는 g뿐이다(루트 svg 말고 안쪽 svg는 좌표계가 바뀌므로 들어가지 않고 무시 목록에 svg로 넣는다).
//   polygon·rect·path·circle만 읽고, 그 밖의 요소는 안을 보지 않고 이름만 ignored에 넣는다. 처리 명령(<?xml-stylesheet?> 등)도 이름만 넣는다.
//   읽지 않은 속성(style·href·xlink:href·on*·transform 등)도 이름만 넣는다. xmlns 선언은 넣지 않는다.
// - 구역: polygon(points)·rect(x·y·width·height)·path(d의 M·L·H·V·Z와 소문자 상대 명령)에 data-section(없으면 id)이 있는 것.
//   곡선 명령과 갈래가 둘 이상인 경로(M이 두 번)는 행 오류 PATH_UNSUPPORTED다(구역 도형은 닫힌 다각형 하나). 무대: data-kind="stage"인
//   polygon·rect·path(circle은 늘 좌석이다). 좌석: circle(cx·cy)에 data-section·data-row·data-number.
// - 좌표 칸 하나는 64자, d는 64KB까지이고 숫자는 겹치지 않는 꼴로 읽는다(되돌기가 커지지 않게, ADR-0257 결정 5).
import type { LayoutShape, Point } from '../modules/catalog/domain/seatmap-import.js';
import { coord, LayoutBuilder, num as numberOf, NUMBER_FIELD_MAX, Rejected, type ParsedLayout } from './layout-builder.js';

/** 경로 d 상한 [가정] */
const PATH_D_MAX = 64 * 1024;

const SHAPES = new Set(['polygon', 'rect', 'path', 'circle']);
const CONTAINERS = new Set(['g']);
/** 도형마다 읽는 좌표 속성(그 밖은 무시 목록) */
const SHAPE_ATTRS: Record<string, readonly string[]> = {
  polygon: ['points'],
  rect: ['x', 'y', 'width', 'height'],
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
};
const SEAT_ATTRS = ['data-section', 'data-row', 'data-number', 'data-tier', 'data-wheelchair', 'data-gate'];
const AREA_ATTRS = ['data-section', 'data-kind', 'id'];
const ROOT_ATTRS = ['viewBox', 'width', 'height', 'version'];
const NAME = /^[A-Za-z_][\w.:-]*$/;

const mismatch = (line: number) => new Rejected('FORMAT_MISMATCH', line, 'svg');

const REF = /^(?:lt|gt|amp|quot|apos|#x[0-9a-fA-F]{1,6}|#[0-9]{1,7})$/;

/** 다섯 엔터티와 숫자 문자 참조만 푼다. 그 밖의 &…;와 홀로 쓴 &는 FORMAT_MISMATCH다(XML에서 &는 늘 참조의 시작이다) */
function decodeEntities(v: string, line: number): string {
  if (!v.includes('&')) return v;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = v.indexOf('&', i);
    if (amp < 0) return out + v.slice(i);
    const semi = v.indexOf(';', amp + 1);
    const ent = semi < 0 || semi - amp > 9 ? '' : v.slice(amp + 1, semi);
    if (!REF.test(ent)) throw mismatch(line);
    out += v.slice(i, amp) + entityChar(ent, line);
    i = semi + 1;
  }
}

function entityChar(ent: string, line: number): string {
  switch (ent) {
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'amp':
      return '&';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
  }
  const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
  if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
  throw mismatch(line);
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  selfClosing: boolean;
  line: number;
}

/** 줄 번호를 앞에서부터 이어 센다(같은 글을 두 번 세지 않는다) */
class Lines {
  #at = 0;
  #line = 1;
  constructor(private readonly text: string) {}
  lineAt(pos: number): number {
    for (let i = this.#at; i < pos; i++) if (this.text.charCodeAt(i) === 10) this.#line++;
    this.#at = Math.max(this.#at, pos);
    return this.#line;
  }
}

function parseTag(text: string, start: number, lines: Lines): { tag: Tag; end: number } {
  const line = lines.lineAt(start);
  let i = start + 1;
  const nameStart = i;
  while (i < text.length && !/[\s/>]/.test(text[i]!)) i++;
  const name = text.slice(nameStart, i);
  if (!NAME.test(name)) throw mismatch(line);
  const attrs = new Map<string, string>();
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) throw mismatch(line);
    if (text[i] === '>') return { tag: { name, attrs, selfClosing: false, line }, end: i + 1 };
    if (text[i] === '/') {
      if (text[i + 1] !== '>') throw mismatch(line);
      return { tag: { name, attrs, selfClosing: true, line }, end: i + 2 };
    }
    const an = i;
    while (i < text.length && !/[\s=/>]/.test(text[i]!)) i++;
    const attr = text.slice(an, i);
    if (!NAME.test(attr) || attrs.has(attr)) throw mismatch(line);
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] !== '=') throw mismatch(line);
    i++;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    const q = text[i];
    if (q !== '"' && q !== "'") throw mismatch(line);
    const close = text.indexOf(q, i + 1);
    if (close < 0) throw mismatch(line);
    const raw = text.slice(i + 1, close);
    if (raw.includes('<')) throw mismatch(line);
    attrs.set(attr, decodeEntities(raw, line));
    i = close + 1;
  }
}

/** points="x,y x,y …" */
function polygonPoints(raw: string, line: number): Point[] | 'invalid' {
  const parts = raw.trim().split(/[\s,]+/).filter((p) => p !== '');
  if (parts.length % 2 !== 0) return 'invalid';
  LayoutBuilder.checkPoints(parts.length / 2, line, 'points');
  const out: Point[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const x = coord(parts[k]);
    const y = coord(parts[k + 1]);
    if (x === undefined || y === undefined) return 'invalid';
    out.push([x, y]);
  }
  return out.length >= 3 ? out : 'invalid';
}

/** path d의 직선 명령만 읽는다(한 갈래). 곡선 명령은 'curve' */
function pathPoints(d: string, line: number): Point[] | 'invalid' | 'curve' {
  if (d.length > PATH_D_MAX) return 'invalid';
  const tokens: string[] = [];
  // 앞 구분자는 [\s,]* 하나다(\s*,?\s*처럼 겹치는 반복은 실패할 때 되돌기가 길이의 제곱이 된다)
  const re = /[\s,]*([A-Za-z]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
  let pos = 0;
  while (pos < d.length) {
    re.lastIndex = pos;
    const m = re.exec(d);
    if (!m) {
      if (/^[\s,]*$/.test(d.slice(pos))) break;
      return 'invalid';
    }
    if (m[1]!.length > NUMBER_FIELD_MAX) return 'invalid';
    tokens.push(m[1]!);
    pos = re.lastIndex;
  }
  const pts: Point[] = [];
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let closed = false;
  let k = 0;
  const num = () => {
    const t = tokens[k];
    if (t === undefined || /[A-Za-z]/.test(t)) return undefined;
    k++;
    return Number(t);
  };
  const push = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return false;
    cx = x;
    cy = y;
    pts.push([Math.round(x), Math.round(y)]);
    LayoutBuilder.checkPoints(pts.length, line, 'd');
    return true;
  };
  while (k < tokens.length) {
    const t = tokens[k]!;
    if (/[A-Za-z]/.test(t)) {
      if (/[CcSsQqTtAa]/.test(t)) return 'curve';
      if (!/[MmLlHhVvZz]/.test(t)) return 'invalid';
      if (closed) return 'curve';
      if ((t === 'M' || t === 'm') && pts.length > 0) return 'curve';
      if (pts.length === 0 && t !== 'M' && t !== 'm') return 'invalid';
      cmd = t;
      k++;
      if (t === 'Z' || t === 'z') {
        closed = true;
        continue;
      }
    } else if (cmd === '' || cmd === 'Z' || cmd === 'z') return 'invalid';
    const rel = cmd === cmd.toLowerCase();
    if (cmd === 'H' || cmd === 'h') {
      const x = num();
      if (x === undefined || !push(rel ? cx + x : x, cy)) return 'invalid';
    } else if (cmd === 'V' || cmd === 'v') {
      const y = num();
      if (y === undefined || !push(cx, rel ? cy + y : y)) return 'invalid';
    } else {
      const x = num();
      const y = num();
      if (x === undefined || y === undefined || !push(rel ? cx + x : x, rel ? cy + y : y)) return 'invalid';
      // M 뒤의 좌표 쌍은 L이다(SVG 규칙)
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
    }
  }
  const first = pts[0];
  const last = pts.at(-1);
  if (pts.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) pts.pop();
  return pts.length >= 3 ? pts : 'invalid';
}

function readShape(tag: Tag, b: LayoutBuilder): LayoutShape | undefined {
  const a = tag.attrs;
  const bad = (field: string, code: string): undefined => {
    b.issue(tag.line, field, code);
    return undefined;
  };
  if (tag.name === 'polygon') {
    const pts = polygonPoints(a.get('points') ?? '', tag.line);
    return pts === 'invalid' ? bad('points', 'SHAPE_INVALID') : { kind: 'POLYGON', points: pts };
  }
  if (tag.name === 'rect') {
    // 네 꼭짓점을 구한 뒤 반올림한다(폭·높이를 먼저 반올림하면 0.4 + 0.4가 0이 된다)
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => numberOf(a.get(k) ?? (k === 'x' || k === 'y' ? '0' : undefined)));
    if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return bad('rect', 'SHAPE_INVALID');
    const corners: [number, number][] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return { kind: 'RECT', points: corners.map(([px, py]) => [Math.round(px), Math.round(py)] as Point) };
  }
  const pts = pathPoints(a.get('d') ?? '', tag.line);
  if (pts === 'curve') return bad('d', 'PATH_UNSUPPORTED');
  if (pts === 'invalid') return bad('d', 'SHAPE_INVALID');
  return { kind: 'POLYGON', points: pts };
}

/** 쓰지 않은 속성 이름을 무시 목록에 넣는다 */
function ignoreOthers(tag: Tag, used: readonly string[], b: LayoutBuilder): void {
  for (const k of tag.attrs.keys()) {
    if (k === 'xmlns' || k.startsWith('xmlns:') || used.includes(k)) continue;
    b.ignore(k);
  }
}

function onShape(tag: Tag, b: LayoutBuilder): void {
  const a = tag.attrs;
  if (tag.name === 'circle') {
    ignoreOthers(tag, [...SHAPE_ATTRS.circle!, ...SEAT_ATTRS, 'id'], b);
    const section = a.get('data-section');
    const row = a.get('data-row');
    const number = a.get('data-number');
    if (section === undefined && row === undefined && number === undefined) return;
    const x = coord(a.get('cx') ?? '0');
    const y = coord(a.get('cy') ?? '0');
    if (section === undefined || row === undefined || number === undefined) {
      b.countSeat(tag.line);
      b.issue(tag.line, 'circle', 'SEAT_FIELDS_MISSING');
      return;
    }
    if (x === undefined || y === undefined) {
      b.countSeat(tag.line);
      b.issue(tag.line, 'cx', 'COORD_INVALID');
      return;
    }
    const wheel = a.get('data-wheelchair');
    b.addSeat({
      line: tag.line,
      section,
      row,
      number,
      x,
      y,
      ...(a.has('data-tier') ? { tierId: a.get('data-tier')! } : {}),
      ...(wheel !== undefined ? { wheelchair: wheel.trim() === 'true' } : {}),
      ...(a.has('data-gate') ? { gateZone: a.get('data-gate')! } : {}),
    });
    return;
  }
  ignoreOthers(tag, [...SHAPE_ATTRS[tag.name]!, ...AREA_ATTRS], b);
  const stage = a.get('data-kind') === 'stage';
  const name = a.get('data-section') ?? a.get('id');
  if (!stage && name === undefined) return;
  const shape = readShape(tag, b);
  if (!shape) return;
  if (stage) b.addStage(name !== undefined ? { ...shape, name } : shape, tag.line);
  else b.addSection(name!, shape, tag.line);
}

function viewBoxCanvas(root: Tag): { width: number; height: number; dx: number; dy: number } | undefined {
  const vb = root.attrs.get('viewBox');
  if (vb !== undefined) {
    const p = vb.trim().split(/[\s,]+/).map((v) => coord(v));
    if (p.length === 4 && p.every((v) => v !== undefined) && p[2]! > 0 && p[3]! > 0) return { dx: p[0]!, dy: p[1]!, width: p[2]!, height: p[3]! };
    return undefined;
  }
  const w = coord(root.attrs.get('width')?.replace(/px$/, ''));
  const h = coord(root.attrs.get('height')?.replace(/px$/, ''));
  return w !== undefined && h !== undefined && w > 0 && h > 0 ? { dx: 0, dy: 0, width: w, height: h } : undefined;
}

/** SVG 글 → 배치. 해석하지 않는 파일이면 Rejected를 던진다 */
export function readSvg(text: string): { layout: ParsedLayout; builder: LayoutBuilder } {
  // DTD는 어디에 있든 받지 않는다(주석 안이라도 거절한다. 위험한 파일을 해석해 보지 않는다)
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new Rejected('DOCTYPE_PRESENT', 0, 'svg');
  const b = new LayoutBuilder();
  const lines = new Lines(text);
  const stack: string[] = [];
  /** 안을 보지 않는 요소의 깊이(0이면 보고 있다) */
  let skip = 0;
  let root: Tag | undefined;
  let rootClosed = false;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (text.slice(i).trim() !== '' && (root === undefined || rootClosed)) throw mismatch(lines.lineAt(i));
      break;
    }
    if (text.slice(i, lt).trim() !== '' && (root === undefined || rootClosed)) throw mismatch(lines.lineAt(i));
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) throw mismatch(lines.lineAt(lt));
      // XML 선언 밖의 처리 명령(<?xml-stylesheet?> 등)은 따르지 않고 이름만 무시 목록에 넣는다
      const target = /^[A-Za-z_][\w.:-]*/.exec(text.slice(lt + 2, Math.min(e, lt + 2 + 64)))?.[0] ?? '?';
      if (target !== 'xml') b.ignore(target);
      i = e + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) throw mismatch(lines.lineAt(lt));
      i = e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw mismatch(lines.lineAt(lt));
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) throw mismatch(lines.lineAt(lt));
      i = e + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw mismatch(lines.lineAt(lt));
    if (text.startsWith('</', lt)) {
      const e = text.indexOf('>', lt + 2);
      if (e < 0) throw mismatch(lines.lineAt(lt));
      const name = text.slice(lt + 2, e).trim();
      if (stack.pop() !== name) throw mismatch(lines.lineAt(lt));
      if (skip > 0) skip--;
      if (stack.length === 0) rootClosed = true;
      i = e + 1;
      continue;
    }
    const { tag, end } = parseTag(text, lt, lines);
    i = end;
    if (rootClosed) throw mismatch(tag.line);
    if (!root) {
      if (tag.name !== 'svg') throw mismatch(tag.line);
      root = tag;
      ignoreOthers(tag, ROOT_ATTRS, b);
      if (tag.selfClosing) rootClosed = true;
      else stack.push(tag.name);
      continue;
    }
    if (skip > 0) {
      if (!tag.selfClosing) {
        stack.push(tag.name);
        skip++;
      }
      continue;
    }
    if (CONTAINERS.has(tag.name)) {
      ignoreOthers(tag, ['id'], b);
      if (!tag.selfClosing) stack.push(tag.name);
      continue;
    }
    if (SHAPES.has(tag.name)) {
      onShape(tag, b);
      // 도형 안의 요소(title·animate 등)는 보지 않는다
      if (!tag.selfClosing) {
        stack.push(tag.name);
        skip = 1;
      }
      continue;
    }
    b.ignore(tag.name);
    if (!tag.selfClosing) {
      stack.push(tag.name);
      skip = 1;
    }
  }
  if (!root || !rootClosed || stack.length > 0) throw mismatch(lines.lineAt(text.length));
  const vb = viewBoxCanvas(root);
  const layout = b.finish(vb ? { width: vb.width, height: vb.height } : undefined);
  if (vb && (vb.dx !== 0 || vb.dy !== 0)) shift(layout, vb.dx, vb.dy);
  return { layout, builder: b };
}

/** viewBox의 원점이 0이 아니면 좌표를 원점으로 옮긴다 */
function shift(layout: ParsedLayout, dx: number, dy: number): void {
  const mv = (p: Point): Point => [p[0] - dx, p[1] - dy];
  for (const s of layout.stage) s.points = s.points.map(mv);
  for (const s of layout.sections) {
    s.shape.points = s.shape.points.map(mv);
    for (const seat of s.seats) {
      seat.x -= dx;
      seat.y -= dy;
    }
  }
}

