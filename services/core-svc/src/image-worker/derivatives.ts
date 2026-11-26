// F-10-2 image-worker 파생본 규격(계획 docs/review/plans/F-10-2.md §3, docs/data.md §1, docs/frontend.md §5.14.1).
// 공연·배너는 원본 폭 이하의 320·640·960·1,280px × AVIF·WebP, 후기 사진은 240px·긴 변 1,280px WebP만 만든다.
export type ImageKindProto = 'IMAGE_KIND_PRODUCTION' | 'IMAGE_KIND_HOME_BANNER' | 'IMAGE_KIND_REVIEW_PHOTO';
export type Prefix = 'production' | 'banner' | 'review';

export const WIDTHS = [320, 640, 960, 1280] as const;

export function prefixOf(kind: ImageKindProto): Prefix {
  return kind === 'IMAGE_KIND_HOME_BANNER' ? 'banner' : kind === 'IMAGE_KIND_REVIEW_PHOTO' ? 'review' : 'production';
}

/** 준비 위치에 만들 파생본 이름. 원본보다 넓은 폭은 만들지 않는다. */
export function derivativeNamesFor(kind: ImageKindProto, width: number, height: number): string[] {
  if (kind === 'IMAGE_KIND_REVIEW_PHOTO') {
    const longEdge = Math.max(width, height);
    return longEdge >= 1280 ? ['240.webp', '1280.webp'] : ['240.webp'];
  }
  return WIDTHS.filter((w) => w <= width).flatMap((w) => [`${w}.avif`, `${w}.webp`]);
}

export function stagingKey(prefix: Prefix, imageId: string, name: string): string {
  return `staging/${prefix}/${imageId}/${name}`;
}

export function contentTypeOf(name: string): 'image/avif' | 'image/webp' {
  return name.endsWith('.avif') ? 'image/avif' : 'image/webp';
}

/** 후기 사진의 240px은 목록 썸네일, 1,280px은 보기 파생본이다. 그 밖은 이름의 폭을 쓴다. */
export function targetWidth(name: string): number {
  return Number(name.slice(0, name.indexOf('.')));
}
