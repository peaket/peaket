// 공연 설명 구조 문서 → 그릴 블록(CMP-070, docs/frontend.md §5.14.3, ADR-0204, ADR-0244, ADR-0247). 순수 함수만 둔다.
// 서버가 저장할 때 검사했지만, 다음 판의 문서가 와도 글이 빠진 채 보이지 않게 모르는 판·노드가 하나라도 있으면 null(글자판으로 그린다)이다.

export type DescriptionInline = { t: 'text'; v: string; b?: true } | { t: 'br' };
export type DescriptionBlock = { t: 'p'; c: DescriptionInline[] } | { t: 'h'; level: 2 | 3; c: DescriptionInline[] } | { t: 'ul' | 'ol'; items: DescriptionInline[][] };

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

function inlines(c: unknown): DescriptionInline[] | null {
  if (!Array.isArray(c)) return null;
  const out: DescriptionInline[] = [];
  for (const n of c) {
    if (!isObj(n)) return null;
    if (n.t === 'br') out.push({ t: 'br' });
    else if (n.t === 'text' && typeof n.v === 'string') out.push({ t: 'text', v: n.v, ...(n.b === true ? { b: true as const } : {}) });
    else return null;
  }
  return out;
}

function block(b: unknown): DescriptionBlock | 'empty' | null {
  if (!isObj(b)) return null;
  if (b.t === 'p' || b.t === 'h') {
    const c = inlines(b.c);
    if (!c) return null;
    if (b.t === 'h' && b.level !== 2 && b.level !== 3) return null;
    if (c.length === 0) return 'empty';
    return b.t === 'p' ? { t: 'p', c } : { t: 'h', level: b.level as 2 | 3, c };
  }
  if ((b.t === 'ul' || b.t === 'ol') && Array.isArray(b.items)) {
    const items: DescriptionInline[][] = [];
    for (const line of b.items) {
      const c = inlines(line);
      if (!c) return null;
      if (c.length > 0) items.push(c);
    }
    return items.length > 0 ? { t: b.t, items } : 'empty';
  }
  return null;
}

/** 구조 문서를 그릴 블록으로. 없거나 모르는 내용이 있거나 비었으면 null */
export function toDescriptionBlocks(doc: unknown): DescriptionBlock[] | null {
  if (!isObj(doc) || doc.v !== 1 || !Array.isArray(doc.blocks)) return null;
  const out: DescriptionBlock[] = [];
  for (const b of doc.blocks) {
    const parsed = block(b);
    if (parsed === null) return null;
    if (parsed !== 'empty') out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

/** 블록마다 그릴 제목 꼬리표(제목이 아니면 null). 절 제목이 h2라 h3부터 쓰고, 큰 제목 없이 작은 제목이 오면 차례를 건너뛰지 않게 h3로 쓴다 */
export function headingTags(blocks: DescriptionBlock[]): ('h3' | 'h4' | null)[] {
  let underLarge = false;
  return blocks.map((b) => {
    if (b.t !== 'h') return null;
    if (b.level === 2) {
      underLarge = true;
      return 'h3';
    }
    return underLarge ? 'h4' : 'h3';
  });
}
