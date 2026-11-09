// 도메인 층: 공연 설명 구조 문서(CMP-070, asvs/catalog-review 1.3.1, ADR-0204, ADR-0244)의 합계 상한과 글자판. 화면 쪽 apps/partner rich-text/doc.ts와 같은 규칙이다.

export type DescriptionInline = { t: 'text'; v: string; b?: true } | { t: 'br' };
export type DescriptionBlock = { t: 'p'; c: DescriptionInline[] } | { t: 'h'; level: 2 | 3; c: DescriptionInline[] } | { t: 'ul' | 'ol'; items: DescriptionInline[][] };
export interface DescriptionDoc {
  v: 1;
  blocks: DescriptionBlock[];
}

export interface KopisFields {
  producer?: string;
  notice?: string;
}

/** 합계 상한 [가정] */
export const MAX_DESCRIPTION_BLOCKS = 200;
export const MAX_DESCRIPTION_CHARS = 20_000;
export const MAX_DESCRIPTION_NODES = 5_000;

/** 글자판 길이와 노드 합계가 상한 안인가. 글자판 전체를 재서 공연 상세가 글자판을 자르지 않게 한다 */
export function withinDescriptionLimits(doc: DescriptionDoc): boolean {
  let nodes = 0;
  const count = (c: DescriptionInline[]) => {
    nodes += c.length;
  };
  for (const b of doc.blocks) {
    if ('items' in b) {
      for (const line of b.items) {
        nodes += 1;
        count(line);
      }
    } else count(b.c);
  }
  return nodes <= MAX_DESCRIPTION_NODES && descriptionText(doc).length <= MAX_DESCRIPTION_CHARS;
}

/** 글자판: 블록 사이는 빈 줄, 목록 항목·줄바꿈은 줄바꿈이다(공연 상세 화면이 빈 줄로 문단을 나눈다) */
export function descriptionText(doc: DescriptionDoc): string {
  const line = (c: DescriptionInline[]) => c.map((n) => (n.t === 'br' ? '\n' : n.v)).join('');
  return doc.blocks.map((b) => ('items' in b ? b.items.map(line).join('\n') : line(b.c))).join('\n\n');
}
