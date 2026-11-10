'use client';
// 좌석맵 에디터 늦게 싣기(ADR-0264 결정 2, frontend §5.6 '늦게 싣기'): 첫 화면은 뼈대(계층 트리 자리·도구 막대 자리)만 그리고,
// 캔버스(Konva)·도구·저장소·Worker는 next/dynamic(ssr: false)으로 그 뒤에 싣는다. 첫 화면 JS에 Konva가 들지 않는다(FE-T46 ⑬).
// 폭 768px 미만에서는 편집 화면을 싣지 않고 미리보기와 요약 줄만 싣는다(ADR-0264 결정 39). 편집 화면을 한 번 띄운 뒤 창을 줄이면
// 저장하지 않은 편집을 잃지 않게 내리지 않고 숨긴다.
import dynamic from 'next/dynamic';
import { useEffect, useState, useSyncExternalStore } from 'react';

function Skeleton() {
  return (
    <div className="col gap-4" aria-busy="true">
      <div className="card" style={{ padding: '8px 10px', minHeight: 88 }} aria-hidden="true" />
      <div className="grid gap-4 lg:[grid-template-columns:minmax(0,2fr)_minmax(0,7fr)_minmax(0,3fr)]">
        <section className="card col" style={{ padding: '12px 8px', gap: 10, minHeight: 520 }} aria-labelledby="h-tree-skel">
          <h2 className="t-md fw-b" id="h-tree-skel" style={{ padding: '0 4px' }}>
            좌석 계층
          </h2>
          <p className="t-sm muted" role="status">
            에디터를 싣는 중입니다
          </p>
        </section>
        <div className="card" style={{ minHeight: 580 }} aria-hidden="true" />
        <div className="card max-lg:hidden" style={{ minHeight: 580 }} aria-hidden="true" />
      </div>
    </div>
  );
}

const EditorApp = dynamic(() => import('./EditorApp'), { ssr: false, loading: Skeleton });
const MobileView = dynamic(() => import('./MobileView'), { ssr: false, loading: () => <p className="t-sm muted" role="status">좌석맵을 불러오는 중입니다</p> });

/** 편집 화면을 띄우는 폭(d5 반응형 md) */
const WIDE = '(min-width: 768px)';
const onWidth = (cb: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};
const isWide = () => window.matchMedia(WIDE).matches;

export function LiveSeatmapEditor({ productionId }: { productionId: string }) {
  // 서버 그리기와 첫 수화는 폭을 모른다(null)
  const wide = useSyncExternalStore(onWidth, isWide, () => null);
  const [editorShown, setEditorShown] = useState(false);
  useEffect(() => {
    if (wide) setEditorShown(true);
  }, [wide]);
  if (wide === null) return <Skeleton />;
  if (wide || editorShown)
    return (
      <div className="max-md:hidden col gap-4" style={{ flex: 1 }}>
        <EditorApp productionId={productionId} />
      </div>
    );
  return <MobileView productionId={productionId} />;
}
