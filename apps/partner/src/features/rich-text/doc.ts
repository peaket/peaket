// 공연 설명 구조 문서(CMP-070, docs/design/d2 CMP-070, docs/frontend.md §5.14.3, asvs/catalog-review 1.3.1, BUILD_ORDER HOT-322 FE-T41).
// HTML이 아니라 허용 노드 다섯만 담은 JSON으로 저장하고, 보여 줄 때 노드마다 React 요소로 그린다(HTML을 넣지 않는다).
// 허용 노드: 문단 p · 줄바꿈 br · 강조(글자 노드의 b) · 목록 ul·ol(항목은 글자 줄, 안쪽 목록은 펼친다) · 제목 h(단계 2·3).
// 편집기(Lexical)가 꺼낸 JSON을 이 문서로 바꾸고, 다시 열 때는 되돌린다. 그 밖의 노드(표·인용·코드·링크·그림)는 글자로 낮추거나 버리고, 속성(스타일·주소)은 버린다.
// 서버(core-svc)는 같은 규칙을 Zod로 다시 본다(ADR-0244). 순수 함수라 node --test가 바로 돌린다.

export type Inline = { t: 'text'; v: string; b?: true } | { t: 'br' };
export type Block = { t: 'p'; c: Inline[] } | { t: 'h'; level: 2 | 3; c: Inline[] } | { t: 'ul' | 'ol'; items: Inline[][] };
export interface PeaketDoc {
  v: 1;
  blocks: Block[];
}

/** 상한 [가정]: 블록 200개, 글자 20,000자, 노드(글자·줄바꿈) 5,000개, 변환할 때 겹침 깊이 64 */
export const MAX_BLOCKS = 200;
export const MAX_CHARS = 20_000;
export const MAX_NODES = 5_000;
const MAX_DEPTH = 64;

type Json = Record<string, unknown>;
const obj = (x: unknown): Json => (typeof x === 'object' && x !== null ? (x as Json) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** 붙은 글자 노드를 합친다(같은 굵기) */
function tidy(c: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of c) {
    const last = out.at(-1);
    if (n.t === 'text' && n.v === '') continue;
    if (n.t === 'text' && last?.t === 'text' && !!last.b === !!n.b) last.v += n.v;
    else out.push(n.t === 'text' ? { ...n } : n);
  }
  return out;
}

// ── Lexical(editorState.toJSON()) ──
const LEX_BOLD = 1;

function lexInline(n: Json, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return [];
  switch (n.type) {
    case 'text':
      return [{ t: 'text', v: String(n.text ?? ''), ...((Number(n.format) & LEX_BOLD) !== 0 ? { b: true as const } : {}) }];
    case 'linebreak':
      return [{ t: 'br' }];
    case 'tab':
      return [{ t: 'text', v: '\t' }];
    default:
      // 링크·그 밖의 글자 묶음은 안쪽 글자만
      return arr(n.children).flatMap((x) => lexInline(obj(x), depth + 1));
  }
}

function lexBlocks(n: Json, depth = 0): Block[] {
  if (depth > MAX_DEPTH) return [];
  switch (n.type) {
    case 'paragraph':
      return [{ t: 'p', c: tidy(arr(n.children).flatMap((x) => lexInline(obj(x)))) }];
    case 'heading':
      return [{ t: 'h', level: n.tag === 'h1' || n.tag === 'h2' ? 2 : 3, c: tidy(arr(n.children).flatMap((x) => lexInline(obj(x)))) }];
    case 'list':
      return [{ t: n.listType === 'number' ? 'ol' : 'ul', items: lexItems(n, depth + 1) }];
    default: {
      // 인용·코드·표 등: 안쪽에 블록이 있으면 그 블록들, 없으면 글자를 문단 하나로
      const kids = arr(n.children).map(obj);
      if (kids.some((k) => ['paragraph', 'heading', 'list', 'quote', 'table', 'tablerow', 'tablecell', 'code'].includes(String(k.type)))) return kids.flatMap((k) => lexBlocks(k, depth + 1));
      return [{ t: 'p', c: tidy(kids.flatMap((k) => lexInline(k))) }];
    }
  }
}

function lexItems(list: Json, depth: number): Inline[][] {
  if (depth > MAX_DEPTH) return [];
  return arr(list.children).flatMap((x) => {
    const item = obj(x);
    const kids = arr(item.children).map(obj);
    const nested = kids.filter((k) => k.type === 'list');
    const own = tidy(kids.filter((k) => k.type !== 'list').flatMap((k) => lexInline(k)));
    return [...(own.length > 0 || nested.length === 0 ? [own] : []), ...nested.flatMap((l) => lexItems(l, depth + 1))];
  });
}

export function fromLexical(state: unknown): PeaketDoc {
  return { v: 1, blocks: arr(obj(obj(state).root).children).flatMap((x) => lexBlocks(obj(x))) };
}

const LEX_ELEMENT = { direction: null, format: '', indent: 0, version: 1 };

function toLexInline(c: unknown): Json[] {
  return arr(c).flatMap((x): Json[] => {
    const n = obj(x);
    if (n.t === 'br') return [{ type: 'linebreak', version: 1 }];
    if (n.t !== 'text' || typeof n.v !== 'string') return [];
    return [{ type: 'text', text: n.v, format: n.b === true ? LEX_BOLD : 0, detail: 0, mode: 'normal', style: '', version: 1 }];
  });
}

function toLexBlock(x: unknown): Json[] {
  const b = obj(x);
  if (b.t === 'p') return [{ ...LEX_ELEMENT, type: 'paragraph', textFormat: 0, textStyle: '', children: toLexInline(b.c) }];
  if (b.t === 'h') return [{ ...LEX_ELEMENT, type: 'heading', tag: b.level === 3 ? 'h3' : 'h2', children: toLexInline(b.c) }];
  if (b.t !== 'ul' && b.t !== 'ol') return [];
  const children = arr(b.items).map((line, i) => ({ ...LEX_ELEMENT, type: 'listitem', value: i + 1, children: toLexInline(line) }));
  return [{ ...LEX_ELEMENT, type: 'list', listType: b.t === 'ol' ? 'number' : 'bullet', start: 1, tag: b.t, children }];
}

/** 구조 문서 → 편집기 상태(다시 열 때). 그릴 블록이 없으면 null(빈 편집기로 시작한다) */
export function toLexical(doc: unknown): { root: Json } | null {
  const children = arr(obj(doc).blocks).flatMap(toLexBlock);
  return children.length > 0 ? { root: { ...LEX_ELEMENT, type: 'root', children } } : null;
}

// ── 검사(저장 전·서버와 같은 규칙) ──
function extraKeys(n: Json, allowed: string[]): string[] {
  return Object.keys(n).filter((k) => !allowed.includes(k));
}

function checkInline(n: unknown, at: string, errs: string[], shapeOnly: boolean): number {
  const o = obj(n);
  if (o.t === 'br') {
    for (const k of extraKeys(o, ['t'])) errs.push(`${at}: 모르는 속성 ${k}`);
    return 0;
  }
  if (o.t !== 'text') {
    errs.push(`${at}: 모르는 노드 ${String(o.t)}`);
    return 0;
  }
  for (const k of extraKeys(o, ['t', 'v', 'b'])) errs.push(`${at}: 모르는 속성 ${k}`);
  if (typeof o.v !== 'string') errs.push(`${at}: 글자가 아니다`);
  else if (!shapeOnly && (/\p{Cs}/u.test(o.v) || o.v.includes('\u0000'))) errs.push(`${at}: 저장할 수 없는 글자가 있다`);
  if (o.b !== undefined && o.b !== true) errs.push(`${at}: 굵기는 true만`);
  return typeof o.v === 'string' ? o.v.length : 0;
}

/** 허용 노드 다섯 밖의 노드·속성, 모양(배열 칸), 상한을 본다. 빈 목록이면 통과. 재귀하지 않는다(서버 Zod가 같은 규칙). 'shape'이면 노드와 모양만 본다(임시저장 복원) */
export function validateDoc(doc: unknown, mode?: 'shape'): string[] {
  const shapeOnly = mode === 'shape';
  const d = obj(doc);
  const errs: string[] = [];
  if (d.v !== 1) return ['v: 판은 1'];
  for (const k of extraKeys(d, ['v', 'blocks'])) errs.push(`문서: 모르는 속성 ${k}`);
  if (!Array.isArray(d.blocks)) return [...errs, '문서: blocks는 배열'];
  const blocks: unknown[] = d.blocks;
  if (!shapeOnly && blocks.length > MAX_BLOCKS) errs.push(`문서: 블록은 ${MAX_BLOCKS}개까지`);
  let chars = 0;
  let nodes = 0;
  blocks.forEach((b, i) => {
    const o = obj(b);
    const at = `blocks[${i}]`;
    if (o.t === 'p' || o.t === 'h') {
      for (const k of extraKeys(o, o.t === 'h' ? ['t', 'level', 'c'] : ['t', 'c'])) errs.push(`${at}: 모르는 속성 ${k}`);
      if (o.t === 'h' && o.level !== 2 && o.level !== 3) errs.push(`${at}: 제목 단계는 2·3`);
      if (!Array.isArray(o.c)) errs.push(`${at}: c는 배열`);
      else {
        nodes += o.c.length;
        o.c.forEach((n, j) => (chars += checkInline(n, `${at}.c[${j}]`, errs, shapeOnly)));
      }
    } else if (o.t === 'ul' || o.t === 'ol') {
      for (const k of extraKeys(o, ['t', 'items'])) errs.push(`${at}: 모르는 속성 ${k}`);
      if (!Array.isArray(o.items)) errs.push(`${at}: items는 배열`);
      else
        o.items.forEach((ln, j) => {
          if (!Array.isArray(ln)) errs.push(`${at}.items[${j}]: 줄은 배열`);
          else {
            nodes += ln.length + 1;
            ln.forEach((n, k) => (chars += checkInline(n, `${at}.items[${j}][${k}]`, errs, shapeOnly)));
          }
        });
    } else errs.push(`${at}: 모르는 노드 ${String(o.t)}`);
  });
  if (shapeOnly) return errs;
  // 서버는 글자판 전체(블록 사이 빈 줄 포함)로 잰다(ADR-0244). 블록 사이 두 글자를 더한다
  const gaps = Math.max(0, blocks.length - 1) * 2;
  const lineBreaks = blocks.reduce<number>((sum, b) => {
    const o = obj(b);
    if (!Array.isArray(o.items)) return sum + (Array.isArray(o.c) ? o.c.filter((n) => obj(n).t === 'br').length : 0);
    return sum + Math.max(0, o.items.length - 1) + o.items.reduce<number>((s2, ln) => s2 + (Array.isArray(ln) ? ln.filter((n) => obj(n).t === 'br').length : 0), 0);
  }, 0);
  if (chars + gaps + lineBreaks > MAX_CHARS) errs.push(`문서: 글자는 ${MAX_CHARS.toLocaleString('en-US')}자까지`);
  if (nodes > MAX_NODES) errs.push(`문서: 노드는 ${MAX_NODES.toLocaleString('en-US')}개까지`);
  return errs;
}

/** 글자판(서버와 같다, ADR-0244): 블록 사이는 빈 줄, 목록 항목·줄바꿈은 줄바꿈이다. 길이 상한은 이 글로 잰다 */
export function docPlainText(doc: PeaketDoc): string {
  const line = (c: Inline[]) => c.map((n) => (n.t === 'br' ? '\n' : n.v)).join('');
  return doc.blocks.map((b) => ('items' in b ? b.items.map(line).join('\n') : line(b.c))).join('\n\n');
}

/** 글자가 없는 문서는 설명이 없는 것이다(ADR-0244 결정 5) */
export function isEmptyDoc(doc: PeaketDoc): boolean {
  return docPlainText(doc).trim() === '';
}
