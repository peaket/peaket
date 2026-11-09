// 공연 설명 구조 문서를 노드마다 React 요소로 그린다(CMP-070, docs/frontend.md §5.14.3 '출력'). HTML을 넣지 않는다(글자는 텍스트 노드).
// 소비자 웹의 공연 상세(⑭ 공연 설명)가 같은 모양으로 그린다(HOT-180·HOT-306에서 apps/web으로 옮긴다).
import type { ReactNode } from 'react';
import type { Inline, PeaketDoc } from './doc';

function inline(c: Inline[]): ReactNode[] {
  return c.map((n, i) => (n.t === 'br' ? <br key={i} /> : n.b ? <strong key={i}>{n.v}</strong> : n.v));
}

export function DocView({ doc }: { doc: PeaketDoc }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      {doc.blocks.map((b, i) => {
        if (b.t === 'p') return <p key={i}>{inline(b.c)}</p>;
        if (b.t === 'h') return b.level === 2 ? <h2 key={i}>{inline(b.c)}</h2> : <h3 key={i}>{inline(b.c)}</h3>;
        const items = b.items.map((line, j) => <li key={j}>{inline(line)}</li>);
        return b.t === 'ol' ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      })}
    </div>
  );
}
