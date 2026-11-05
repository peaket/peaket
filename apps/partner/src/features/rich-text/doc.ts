// 공연 설명 구조 문서(CMP-070, docs/design/d2 CMP-070, docs/frontend.md §5.14.3, asvs/catalog-review 1.3.1, BUILD_ORDER HOT-322 FE-T41).
// HTML이 아니라 허용 노드 다섯만 담은 JSON으로 저장하고, 보여 줄 때 노드마다 React 요소로 그린다(HTML을 넣지 않는다).
// 허용 노드: 문단 p · 줄바꿈 br · 강조(글자 노드의 b) · 목록 ul·ol(항목은 글자 줄, 안쪽 목록은 펼친다) · 제목 h(단계 2·3).
// 편집기(Lexical·Tiptap)가 꺼낸 JSON을 이 문서로 바꾼다. 그 밖의 노드(표·인용·코드·링크·그림)는 글자로 낮추거나 버리고, 속성(스타일·주소)은 버린다.
// 서버(core-svc)는 같은 규칙을 Zod로 다시 본다(HOT-180). 순수 함수라 node --test가 바로 돌린다.

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
      return [{ t: 'p', c: tidy(kids.flatMap(lexInline)) }];
    }
  }
}

function lexItems(list: Json, depth: number): Inline[][] {
  if (depth > MAX_DEPTH) return [];
  return arr(list.children).flatMap((x) => {
    const item = obj(x);
    const kids = arr(item.children).map(obj);
    const nested = kids.filter((k) => k.type === 'list');
    const own = tidy(kids.filter((k) => k.type !== 'list').flatMap(lexInline));
    return [...(own.length > 0 || nested.length === 0 ? [own] : []), ...nested.flatMap((l) => lexItems(l, depth + 1))];
  });
}

export function fromLexical(state: unknown): PeaketDoc {
  return { v: 1, blocks: arr(obj(obj(state).root).children).flatMap((x) => lexBlocks(obj(x))) };
}

// ── Tiptap(editor.getJSON(), ProseMirror) ──
function ttInline(n: Json, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return [];
  switch (n.type) {
    case 'text':
      return [{ t: 'text', v: String(n.text ?? ''), ...(arr(n.marks).some((m) => obj(m).type === 'bold') ? { b: true as const } : {}) }];
    case 'hardBreak':
      return [{ t: 'br' }];
    default:
      // 그림 등 글자 없는 것은 버리고, 그 밖은 안쪽 글자만
      return arr(n.content).flatMap((x) => ttInline(obj(x), depth + 1));
  }
}

function ttBlocks(n: Json, depth = 0): Block[] {
  if (depth > MAX_DEPTH) return [];
  switch (n.type) {
    case 'paragraph':
      return [{ t: 'p', c: tidy(arr(n.content).flatMap((x) => ttInline(obj(x)))) }];
    case 'heading':
      return [{ t: 'h', level: Number(obj(n.attrs).level) <= 2 ? 2 : 3, c: tidy(arr(n.content).flatMap((x) => ttInline(obj(x)))) }];
    case 'bulletList':
    case 'orderedList':
      return [{ t: n.type === 'orderedList' ? 'ol' : 'ul', items: ttItems(n, depth + 1) }];
    case 'horizontalRule':
      return [];
    case 'codeBlock':
      return [{ t: 'p', c: tidy(arr(n.content).flatMap((x) => ttInline(obj(x)))) }];
    default: {
      const kids = arr(n.content).map(obj);
      if (kids.some((k) => k.type !== 'text' && k.type !== 'hardBreak')) return kids.flatMap((k) => ttBlocks(k, depth + 1));
      return [{ t: 'p', c: tidy(kids.flatMap(ttInline)) }];
    }
  }
}

function ttItems(list: Json, depth: number): Inline[][] {
  if (depth > MAX_DEPTH) return [];
  return arr(list.content).flatMap((x) => {
    const item = obj(x);
    const kids = arr(item.content).map(obj);
    const nested = kids.filter((k) => k.type === 'bulletList' || k.type === 'orderedList');
    const own: Inline[] = [];
    for (const k of kids.filter((k) => !nested.includes(k))) {
      if (own.length > 0) own.push({ t: 'br' });
      own.push(...arr(k.content).flatMap((y) => ttInline(obj(y))));
    }
    const line = tidy(own);
    return [...(line.length > 0 || nested.length === 0 ? [line] : []), ...nested.flatMap((l) => ttItems(l, depth + 1))];
  });
}

export function fromTiptap(json: unknown): PeaketDoc {
  return { v: 1, blocks: arr(obj(json).content).flatMap((x) => ttBlocks(obj(x))) };
}

// ── 검사(저장 전·서버와 같은 규칙) ──
function extraKeys(n: Json, allowed: string[]): string[] {
  return Object.keys(n).filter((k) => !allowed.includes(k));
}

function checkInline(n: unknown, at: string, errs: string[]): number {
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
  if (o.b !== undefined && o.b !== true) errs.push(`${at}: 굵기는 true만`);
  return typeof o.v === 'string' ? o.v.length : 0;
}

/** 허용 노드 다섯 밖의 노드·속성, 모양(배열 칸), 상한을 본다. 빈 목록이면 통과. 재귀하지 않는다(서버 Zod가 같은 규칙) */
export function validateDoc(doc: unknown): string[] {
  const d = obj(doc);
  const errs: string[] = [];
  if (d.v !== 1) return ['v: 판은 1'];
  for (const k of extraKeys(d, ['v', 'blocks'])) errs.push(`문서: 모르는 속성 ${k}`);
  if (!Array.isArray(d.blocks)) return [...errs, '문서: blocks는 배열'];
  const blocks: unknown[] = d.blocks;
  if (blocks.length > MAX_BLOCKS) errs.push(`문서: 블록은 ${MAX_BLOCKS}개까지`);
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
        o.c.forEach((n, j) => (chars += checkInline(n, `${at}.c[${j}]`, errs)));
      }
    } else if (o.t === 'ul' || o.t === 'ol') {
      for (const k of extraKeys(o, ['t', 'items'])) errs.push(`${at}: 모르는 속성 ${k}`);
      if (!Array.isArray(o.items)) errs.push(`${at}: items는 배열`);
      else
        o.items.forEach((ln, j) => {
          if (!Array.isArray(ln)) errs.push(`${at}.items[${j}]: 줄은 배열`);
          else {
            nodes += ln.length + 1;
            ln.forEach((n, k) => (chars += checkInline(n, `${at}.items[${j}][${k}]`, errs)));
          }
        });
    } else errs.push(`${at}: 모르는 노드 ${String(o.t)}`);
  });
  if (chars > MAX_CHARS) errs.push(`문서: 글자는 ${MAX_CHARS.toLocaleString('en-US')}자까지`);
  if (nodes > MAX_NODES) errs.push(`문서: 노드는 ${MAX_NODES.toLocaleString('en-US')}개까지`);
  return errs;
}

/** 글자만(블록·목록 항목·줄바꿈마다 줄을 바꾼다). 편집기 화면과 다시 그린 화면을 견줄 때 쓴다 */
export function docText(doc: PeaketDoc): string {
  const line = (c: Inline[]) => c.map((n) => (n.t === 'br' ? '\n' : n.v)).join('');
  return doc.blocks.flatMap((b) => ('items' in b ? b.items.map(line) : [line(b.c)])).join('\n');
}
