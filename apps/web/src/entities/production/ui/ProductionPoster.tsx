// 공연 포스터(CMP-072의 그림 자리). 캔버스 키트 17절 .poster-*가 CSS로 그린 예시 그림이다(실제 서비스에서는 파트너가 올린 이미지).
// 포스터는 뜻을 전하는 그림이라 role="img"와 aria-label(공연명 포스터)을 단다. 장식으로 쓸 때는 decorative를 준다.
import type { CSSProperties, ReactNode } from 'react';
import type { PosterArt } from '../model';

export interface ProductionPosterProps {
  art: PosterArt;
  /** sm: 작은 카드(.poster-sm, 짧은 글만) · md: 기본 · lg: 큰 포스터(.poster-lg) */
  size?: 'sm' | 'md' | 'lg';
  title: ReactNode;
  kicker?: ReactNode;
  sub?: ReactNode;
  /** 낭독 이름(예: 'LUMEN 콘서트 2026 서울 포스터') */
  label?: string;
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
  titleClassName?: string;
  kickerClassName?: string;
  subClassName?: string;
}

export function ProductionPoster({
  art,
  size = 'md',
  title,
  kicker,
  sub,
  label,
  decorative = false,
  className,
  style,
  titleClassName,
  kickerClassName,
  subClassName,
}: ProductionPosterProps) {
  const cls = ['poster', `poster-${art}`, size === 'sm' ? 'poster-sm' : size === 'lg' ? 'poster-lg' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} style={style} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
      {kicker ? <span className={['poster-kicker', kickerClassName ?? ''].join(' ').trim()}>{kicker}</span> : null}
      <span className={['poster-title', titleClassName ?? ''].join(' ').trim()}>{title}</span>
      {sub ? <span className={['poster-sub', subClassName ?? ''].join(' ').trim()}>{sub}</span> : null}
    </span>
  );
}
