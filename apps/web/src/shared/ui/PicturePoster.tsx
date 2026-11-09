// 파생본 이미지(<picture>: AVIF 먼저, WebP 대체, docs/frontend.md §5.14.1, ADR-0199 결정 4, BUILD_ORDER HOT-300).
// srcset은 파생본 폭 단계(320·640·960·1280)에서 바로 만든다. next/image의 getImageProps는 클라이언트 묶음을 키워(첫 화면 JS 예산 §5.8)
// 쓰지 않는다. 이미지 최적화 경로(/_next/image)도 쓰지 않는다. 주소가 없으면(파생본이 아직 없다) 같은 비율의 빈 판에 이름만 보인다.
import type { CSSProperties } from 'react';
import { cx } from '@/shared/lib/cx';
import { derivativeUrl, IMAGE_WIDTHS, type ImageFormat } from '@/shared/lib/image-loader';

export interface PicturePosterProps {
  /** 파생본 묶음의 기준 주소. 없으면 빈 판 */
  src?: string | null;
  alt: string;
  /** 그림의 본디 크기(비율과 자리 잡기용) */
  width: number;
  height: number;
  /** 화면에서 차지하는 폭(sizes) */
  sizes: string;
  className?: string;
  style?: CSSProperties;
  /** 첫 화면의 큰 그림(LCP)이면 true: 먼저 받는다 */
  priority?: boolean;
  /** 빈 판에 보일 짧은 이름 */
  fallbackLabel?: string;
}

/** 형식 하나의 srcset('…/320.avif 320w, …/640.avif 640w, …') */
export function derivativeSrcSet(base: string, format: ImageFormat): string {
  return IMAGE_WIDTHS.map((w) => `${derivativeUrl(base, w, format)} ${w}w`).join(', ');
}

export function PicturePoster({ src, alt, width, height, sizes, className, style, priority = false, fallbackLabel }: PicturePosterProps) {
  if (!src) {
    return (
      <span className={['poster', className ?? ''].join(' ').trim()} style={{ aspectRatio: `${width}/${height}`, ...style }} role="img" aria-label={alt}>
        {fallbackLabel ? <span className="poster-title">{fallbackLabel}</span> : null}
      </span>
    );
  }
  return (
    // display는 클래스로 둔다. 인라인으로 두면 호출한 쪽의 hidden·md:block을 덮어 휴대폰에서 그림이 두 장 보인다
    <picture className={cx('block', className)} style={{ aspectRatio: `${width}/${height}`, ...style }}>
      <source type="image/avif" srcSet={derivativeSrcSet(src, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={derivativeSrcSet(src, 'webp')} sizes={sizes} />
      {/* eslint-disable-next-line @next/next/no-img-element -- 파생본을 CDN에서 바로 받는다(이미지 최적화 경로를 쓰지 않는다) */}
      <img
        src={derivativeUrl(src, 640, 'webp')}
        srcSet={derivativeSrcSet(src, 'webp')}
        sizes={sizes}
        alt={alt}
        width={width}
        height={height}
        decoding="async"
        loading={priority ? 'eager' : 'lazy'}
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
      />
    </picture>
  );
}
