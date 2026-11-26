// F-10-2 image-worker 디코딩·다시 인코딩(계획 docs/review/plans/F-10-2.md §3, ASVS 5.1.1·5.2.1·5.2.2·5.2.6·14.2.8).
// 화소 상한은 디코딩 전에 헤더(sharp metadata)로 보고, 다시 인코딩하며 EXIF·GPS·XMP·iCCP를 지운다. 셸 명령을 부르지 않는다.
import sharp, { type Metadata } from 'sharp';
import { contentTypeOf, derivativeNamesFor, type ImageKindProto, targetWidth } from './derivatives.js';

export type ProcessResult =
  | { status: 'ACCEPTED'; width: number; height: number; derivatives: Map<string, Uint8Array> }
  | { status: 'REJECTED'; reason: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'TOO_SMALL' | 'MALWARE' };

const ALLOWED = new Set(['jpeg', 'png', 'webp']);

/** 디코딩 전에 헤더만 읽어 폭·높이를 얻는다. 모르면 undefined(그때만 sharp metadata를 쓴다). */
function headerSize(b: Uint8Array): { width: number; height: number } | undefined {
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) return { width: u32(16), height: u32(20) };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (fourcc === 'VP8X' && b.length >= 30) return { width: 1 + b[24]! + (b[25]! << 8) + (b[26]! << 16), height: 1 + b[27]! + (b[28]! << 8) + (b[29]! << 16) };
    if (fourcc === 'VP8 ' && b.length >= 30) return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
    if (fourcc === 'VP8L' && b.length >= 25) {
      const x = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (x & 0x3fff) + 1, height: ((x >>> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16(i + 2);
      if (marker >= 0xc0 && marker <= 0xc2) return { width: u16(i + 7), height: u16(i + 5) };
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return undefined;
}

/** kind·원본 폭·높이로 파생본을 만든다. 원본보다 넓은 폭은 만들지 않는다. */
export async function processImage(o: { bytes: Uint8Array; kind: ImageKindProto; maxPixels: number }): Promise<ProcessResult> {
  const header = headerSize(o.bytes);
  if (header && (Math.max(header.width, header.height) > 20_000 || header.width * header.height > o.maxPixels)) return { status: 'REJECTED', reason: 'TOO_LARGE' };
  let meta: Metadata;
  try {
    meta = await sharp(o.bytes, { limitInputPixels: false, animated: false }).metadata();
  } catch {
    return { status: 'REJECTED', reason: 'UNSUPPORTED_TYPE' };
  }
  const width = meta.width ?? header?.width ?? 0;
  const height = meta.height ?? header?.height ?? 0;
  if (!ALLOWED.has(meta.format ?? '')) return { status: 'REJECTED', reason: 'UNSUPPORTED_TYPE' };
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return { status: 'REJECTED', reason: 'UNSUPPORTED_TYPE' };
  if (Math.max(width, height) > 20_000 || width * height > o.maxPixels) return { status: 'REJECTED', reason: 'TOO_LARGE' };
  const names = derivativeNamesFor(o.kind, width, height);
  const derivatives = new Map<string, Uint8Array>();
  try {
    for (const name of names) {
      const target = targetWidth(name);
      const resize = o.kind === 'IMAGE_KIND_REVIEW_PHOTO' && height > width ? { height: target } : { width: target };
      const pipeline = sharp(o.bytes, { limitInputPixels: o.maxPixels, animated: false }).rotate().resize({ ...resize, withoutEnlargement: true });
      const out = name.endsWith('.avif') ? await pipeline.avif({ quality: 50, effort: 4 }).toBuffer() : await pipeline.webp({ quality: 80, effort: 4 }).toBuffer();
      derivatives.set(name, new Uint8Array(out));
      // contentTypeOf는 이름의 확장자와 실제 인코딩이 같은지 한 번 더 확인한다.
      if (!contentTypeOf(name)) return { status: 'REJECTED', reason: 'UNSUPPORTED_TYPE' };
    }
  } catch {
    return { status: 'REJECTED', reason: 'UNSUPPORTED_TYPE' };
  }
  return { status: 'ACCEPTED', width, height, derivatives };
}
