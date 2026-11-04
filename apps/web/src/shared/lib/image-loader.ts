// next/image 사용자 로더(docs/frontend.md §5.14.1 '이미지 경로는 하나다', ADR-0199 결정 4, BUILD_ORDER HOT-300).
// 계약의 이미지 주소(posterUrl·배너 imageUrl)는 파생본 묶음의 기준 주소이고, 파생본 하나는 {기준 주소}/{폭}.{avif|webp}다.
// Next.js 이미지 최적화(/_next/image)는 쓰지 않는다. 폭은 파생본 단계 가운데 요청한 폭 이상인 가장 작은 것이다.

/** 파생본 폭 단계 [가정](docs/data.md §1 'S3 공개 정적 객체') */
export const IMAGE_WIDTHS = [320, 640, 960, 1280] as const;
export type ImageFormat = 'avif' | 'webp';

/** 요청한 폭에 맞는 파생본 폭(가장 큰 단계보다 크면 가장 큰 단계) */
export function derivativeWidth(width: number): number {
  return IMAGE_WIDTHS.find((w) => w >= width) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]!;
}

/** 기준 주소 → 파생본 주소. 기준 주소 끝의 / 는 하나로 맞춘다 */
export function derivativeUrl(base: string, width: number, format: ImageFormat): string {
  return `${base.replace(/\/+$/, '')}/${derivativeWidth(width)}.${format}`;
}

/** next.config의 images.loaderFile이 쓰는 기본 로더(WebP). AVIF는 <picture>의 source가 따로 만든다 */
export default function imageLoader({ src, width }: { src: string; width: number; quality?: number }): string {
  return derivativeUrl(src, width, 'webp');
}
