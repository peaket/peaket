// 화면 제목(<title>). 경로가 바뀔 때 새 화면 이름을 알린다(docs/frontend.md §2.7).
import { useEffect } from 'react';

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · PEAKET 관제`;
  }, [title]);
}
