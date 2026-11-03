// CMP-044 Skeleton. 캔버스 키트 14절 .skel 막대. 서버 컴포넌트에서도 쓴다.
// - Skeleton: 막대 하나(<span class="skel" style="height:20px">). 폭·높이·모서리는 보드 값 그대로 준다.
// - SkeletonGroup: 불러오는 구역. aria-busy="true"와 화면 낭독기용 글('불러오는 중')을 단다(d2 CMP-044).
//   보드 마크업: <div aria-busy="true"><span class="sr-only">배너를 불러오는 중</span>…</div>
import type { CSSProperties, ElementType, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** 모서리(px 또는 'var(--r-md)', '50%') */
  radius?: number | string;
  /** text: 높이 16 · title: 높이 22 · block: 높이를 직접 준다 · circle: 지름 = width */
  variant?: 'text' | 'title' | 'block' | 'circle';
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width, height, radius, variant = 'block', className, style }: SkeletonProps) {
  const h = height ?? (variant === 'text' ? 16 : variant === 'title' ? 22 : variant === 'circle' ? width : undefined);
  return (
    <span
      className={cx('skel', className)}
      aria-hidden="true"
      style={{
        ...(width !== undefined ? { width } : null),
        ...(h !== undefined ? { height: h } : null),
        ...(variant === 'circle' ? { borderRadius: '50%', flex: 'none' } : radius !== undefined ? { borderRadius: radius } : null),
        ...style,
      }}
    />
  );
}

export interface SkeletonGroupProps {
  /** 화면 낭독기가 읽을 글. 기본 '불러오는 중' */
  label?: string;
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function SkeletonGroup({ label = '불러오는 중', as: Comp = 'div', className, style, children }: SkeletonGroupProps) {
  return (
    <Comp aria-busy="true" className={className} style={style}>
      <span className="sr-only">{label}</span>
      {children}
    </Comp>
  );
}
