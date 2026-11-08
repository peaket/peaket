// 전체 배치도의 '구역의 남은 좌석' 범례(많음 · 적음 · 매진, d5 §5.10 ①). 실제 화면과 개발 미리보기가 함께 쓴다.
import type { CSSProperties } from 'react';

/** 구역의 남은 좌석 무늬 */
const ZONE_SWATCH: Record<'많음' | '적음' | '매진', CSSProperties> = {
  많음: { background: 'var(--heat-2)' },
  적음: { background: 'repeating-linear-gradient(45deg,var(--heat-2) 0 3px,var(--surface) 3px 5px)' },
  매진: {
    backgroundColor: 'var(--fill-weak-strong)',
    backgroundImage:
      'repeating-linear-gradient(45deg,var(--text-muted) 0 1px,transparent 1px 4px),repeating-linear-gradient(-45deg,var(--text-muted) 0 1px,transparent 1px 4px)',
  },
};

export function Swatch({ style, size }: { style: CSSProperties; size: 'sm' | 'md' }) {
  const box: CSSProperties = size === 'md' ? { width: 16, height: 12, borderRadius: 3 } : { width: 14, height: 10, borderRadius: 2 };
  return <span aria-hidden="true" style={{ display: 'inline-block', ...box, ...style }} />;
}

export function ZoneLevelItems({ size }: { size: 'sm' | 'md' }) {
  return (
    <>
      {(['많음', '적음', '매진'] as const).map((k) => (
        <li key={k} className="legend-item">
          <Swatch style={ZONE_SWATCH[k]} size={size} />
          {k}
        </li>
      ))}
    </>
  );
}

export function ZoneLegend({ size }: { size: 'sm' | 'md' }) {
  return (
    <div className="row wrap gap-x-3 gap-y-1 md:gap-y-1.5">
      <span className="t-xs fw-b">구역의 남은 좌석</span>
      <ul className="legend" aria-label="구역의 남은 좌석" style={{ gap: '4px 12px' }}>
        <ZoneLevelItems size={size} />
      </ul>
    </div>
  );
}
