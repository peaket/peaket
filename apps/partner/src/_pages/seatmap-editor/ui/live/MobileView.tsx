'use client';
// 휴대폰 폭(768px 미만)의 좌석맵 화면(ADR-0264 결정 39, d5 '반응형' SCR-022 행): 불러온 배치의 미리보기와 요약 줄만 보인다.
// 편집 화면(캔버스 Konva·도구·Worker)은 싣지 않는다. 편집 안내 카드는 화면(LiveSeatmapPage)이 그린다.
import { useEffect, useState } from 'react';
import { docFromLayout } from '../../model/doc';
import { loadSeatmap } from '../../model/seatmap-api';
import { createEditorStore, type EditorStore } from '../../model/store';
import { Preview } from './Preview';
import { Summary } from './Summary';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'none' } | { kind: 'ok'; store: EditorStore };

export default function MobileView({ productionId }: { productionId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    const ac = new AbortController();
    loadSeatmap(productionId, ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return;
        if (r.kind === 'none') return setState({ kind: 'none' });
        const v = (r.layout as { layoutVersion?: unknown }).layoutVersion;
        // 읽기만 하는 화면이라 잠근 저장소로 둔다(판은 미리보기 파일의 layoutVersion에만 쓴다)
        setState({ kind: 'ok', store: createEditorStore(docFromLayout(r.layout), typeof v === 'number' ? v : 1, true) });
      },
      () => {
        if (!ac.signal.aborted) setState({ kind: 'error' });
      },
    );
    return () => ac.abort();
  }, [productionId]);
  if (state.kind === 'loading') return <p className="t-sm muted" role="status">좌석맵을 불러오는 중입니다</p>;
  if (state.kind === 'error') return <p className="t-sm muted" role="status">좌석맵을 불러오지 못했습니다</p>;
  if (state.kind === 'none') return <p className="t-sm muted" role="status">아직 저장한 좌석맵이 없습니다</p>;
  return (
    <div className="col gap-4">
      <section className="card col" style={{ padding: 10, gap: 8, minWidth: 0 }} aria-label="미리보기">
        <Preview store={state.store} />
      </section>
      <Summary store={state.store} />
    </div>
  );
}
