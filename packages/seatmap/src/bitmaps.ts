// 구역 비트맵 캐시(docs/frontend.md §5.2 '그리기', docs/features/seat-hold.md §10, BUILD_ORDER HOT-120).
// 좌석은 보이지만 아직 고를 수 없는 배율(좌석 24 CSS px 미만)에서는 구역마다 미리 그린 비트맵을 늘려 그린다.
// 비트맵 하나는 그 배율에서 8MB [가정] 이하일 때만 만들고, 모두 합쳐 64MB [가정]를 넘으면 오래 안 쓴 것부터 버린다(LRU).
// 좌석을 고를 수 있는 배율에서는 비트맵 없이 보이는 좌석만 바로 그린다(BAS-190 PoC: 그 배율의 구역 비트맵은 145MB였다).

export const BITMAP_MAX_BYTES = 8 * 1024 * 1024;
export const CACHE_MAX_BYTES = 64 * 1024 * 1024;

export interface CachedBitmap {
  image: unknown;
  /** 비트맵을 그린 배율(세계 → CSS px) */
  scale: number;
  bytes: number;
  close?: () => void;
}

/** 구역·배율 단계 → 비트맵. Map의 넣은 차례를 쓰는 LRU */
export class BitmapCache {
  private map = new Map<string, CachedBitmap & { section: number }>();
  bytes = 0;
  constructor(
    readonly maxBytes = CACHE_MAX_BYTES,
    readonly maxEntryBytes = BITMAP_MAX_BYTES,
  ) {}

  static key(section: number, bucket: number): string {
    return `${section}:${bucket}`;
  }

  get(section: number, bucket: number): CachedBitmap | undefined {
    const k = BitmapCache.key(section, bucket);
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  /** 넣는다. 하나가 상한을 넘으면 넣지 않고 false */
  set(section: number, bucket: number, bmp: CachedBitmap): boolean {
    if (bmp.bytes > this.maxEntryBytes) return false;
    const k = BitmapCache.key(section, bucket);
    this.drop(k);
    this.map.set(k, { ...bmp, section });
    this.bytes += bmp.bytes;
    for (const old of this.map.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.drop(old);
    }
    return true;
  }

  /** 구역의 상태가 바뀌면 그 구역 비트맵을 모두 버린다 */
  invalidate(section: number): void {
    for (const [k, v] of [...this.map]) if (v.section === section) this.drop(k);
  }

  clear(): void {
    for (const k of [...this.map.keys()]) this.drop(k);
  }

  get size(): number {
    return this.map.size;
  }

  private drop(k: string): void {
    const v = this.map.get(k);
    if (!v) return;
    this.map.delete(k);
    this.bytes -= v.bytes;
    v.close?.();
  }
}

/** 배율을 √2 단계로 올림한 단계 번호와 그 배율(늘려 그릴 때 1/√2배까지만 줄어들어 흐려지지 않는다) */
export function scaleBucket(scale: number): { bucket: number; scale: number } {
  const bucket = Math.ceil(Math.log2(scale) * 2);
  return { bucket, scale: 2 ** (bucket / 2) };
}
