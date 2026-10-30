'use client';
// CMP-016 ProgressBar. 캔버스 키트 12절 .progress 마크업을 그대로 낸다.
// - determinate: <div class="progress" role="progressbar" aria-valuenow aria-valuemin="0" aria-valuemax="100"><span style="width:62%"></span></div>
// - indeterminate: .progress.indet(값 없음, aria-label만)
// - queue(대기열 SCR-008): 위에 '나' 표시(badge-solid)와 눈금, .progress-lg, 빗금 흐름 무늬. aria-valuetext("앞에 3,214명, 약 2분 남음").
//   새 값이 오면 이전 값에서 부드럽게 채운다. 움직임은 transform만 쓴다(d2 CMP-016, 배치·칠하기를 다시 하지 않게).
//   stale(연결 확인 중)은 흐리게(빗금 없이, 불투명도 .45), reduced(움직임 줄이기·저전력)는 효과 없이 값만 보인다.
//   낭독 알림(1분에 한 번)은 화면이 따로 둔 live 영역이 한다. '나' 표시와 무늬는 aria-hidden이다.
import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';
import { usePrefersReducedMotion } from '../../lib/hooks';

export interface ProgressBarProps {
  /** 0~100. 없으면 indeterminate */
  value?: number;
  variant?: 'determinate' | 'indeterminate' | 'queue';
  /** progressbar 이름(aria-label) */
  label: string;
  /** 값의 뜻을 말로(aria-valuetext) */
  valueText?: string;
  tone?: 'primary' | 'success' | 'warning';
  size?: 'md' | 'lg';
  /** queue: 갱신이 멈춘 상태(흐리게) */
  stale?: boolean;
  /** queue: 효과 없이 값만(움직임 줄이기 설정이면 저절로 켜진다) */
  reduced?: boolean;
  /** queue: '나' 표시 글자. 기본 '나' */
  markerLabel?: string;
  className?: string;
  style?: CSSProperties;
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));

export function ProgressBar({
  value,
  variant = value === undefined ? 'indeterminate' : 'determinate',
  label,
  valueText,
  tone = 'primary',
  size,
  stale = false,
  reduced: reducedProp,
  markerLabel = '나',
  className,
  style,
}: ProgressBarProps) {
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedProp ?? prefersReduced;
  const v = clamp(value ?? 0);
  const toneClass = tone === 'success' ? 'progress-success' : tone === 'warning' ? 'progress-warning' : undefined;

  if (variant === 'indeterminate') {
    return (
      <div className={cx('progress', 'indet', size === 'lg' && 'progress-lg', className)} role="progressbar" aria-label={label} style={style}>
        <span />
      </div>
    );
  }

  if (variant === 'determinate') {
    return (
      <div
        className={cx('progress', size === 'lg' && 'progress-lg', toneClass, className)}
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(v)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
        style={style}
      >
        <span style={{ width: `${v}%` }} />
      </div>
    );
  }

  // queue: 막대와 '나' 표시를 같은 transform으로 옮긴다. 표시 층은 왼쪽 바깥(-100%)에 두고 v%만큼 밀어
  // 오른쪽 끝을 값 위치에 맞춘다(오른쪽으로 넘쳐 가로 스크롤이 생기지 않게)
  const motion: CSSProperties = reduced ? {} : { transition: 'transform 300ms cubic-bezier(0.35, 0, 0.35, 1)' };
  const fill: CSSProperties = stale
    ? { background: 'var(--primary)', opacity: 0.45 }
    : reduced
      ? { background: 'var(--primary)' }
      : { background: 'repeating-linear-gradient(-45deg,var(--primary) 0 10px,var(--primary-hover) 10px 20px)' };
  return (
    <div className={className} style={{ position: 'relative', paddingTop: 30, ...style }}>
      <div
        aria-hidden="true"
        style={{ position: 'absolute', top: 0, left: '-100%', width: '100%', height: 30, pointerEvents: 'none', transform: `translateX(${v}%)`, ...motion }}
      >
        <span className="badge badge-solid" style={{ position: 'absolute', top: 0, left: '100%', transform: 'translateX(-50%)', ...(stale ? { opacity: 0.45 } : null) }}>
          {markerLabel}
        </span>
        <span style={{ position: 'absolute', top: 22, left: '100%', width: 2, height: 8, marginLeft: -1, background: 'var(--primary)' }} />
      </div>
      <div
        className="progress progress-lg"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(v)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
      >
        <span style={{ width: '100%', transform: `translateX(${v - 100}%)`, ...fill, ...motion }} />
      </div>
    </div>
  );
}
