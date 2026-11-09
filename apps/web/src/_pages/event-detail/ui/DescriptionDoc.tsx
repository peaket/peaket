// 공연 설명 구조 문서를 노드마다 React 요소로 그린다(CMP-070, docs/frontend.md §5.14.3 '출력', ADR-0247). HTML을 넣지 않는다(글자는 텍스트 노드).
// 절 제목 '상세정보'가 h2라 문서의 제목은 h3부터 그린다(headingTags).
import type { ReactNode } from 'react';
import { headingTags, type DescriptionBlock, type DescriptionInline } from '../model/description';

function inline(c: DescriptionInline[]): ReactNode[] {
  return c.map((n, i) => (n.t === 'br' ? <br key={i} /> : n.b ? <strong key={i}>{n.v}</strong> : n.v));
}

const LIST_MARGIN = { margin: '0 0 10px', paddingLeft: 20 } as const;

export function DescriptionDoc({ blocks }: { blocks: DescriptionBlock[] }) {
  const tags = headingTags(blocks);
  return (
    <div className="prose muted" style={{ whiteSpace: 'pre-wrap' }}>
      {blocks.map((b, i) => {
        if (b.t === 'p') return <p key={i}>{inline(b.c)}</p>;
        if (b.t === 'h') {
          return tags[i] === 'h3' ? (
            <h3 key={i}>{inline(b.c)}</h3>
          ) : (
            <h4 key={i} className="fw-b" style={{ margin: '16px 0 6px' }}>
              {inline(b.c)}
            </h4>
          );
        }
        const items = b.items.map((line, j) => <li key={j}>{inline(line)}</li>);
        return b.t === 'ol' ? (
          <ol key={i} style={{ ...LIST_MARGIN, listStyle: 'decimal' }}>
            {items}
          </ol>
        ) : (
          <ul key={i} style={{ ...LIST_MARGIN, listStyle: 'disc' }}>
            {items}
          </ul>
        );
      })}
    </div>
  );
}
