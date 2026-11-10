// 공연 이미지 입력(SCR-021 1단계 CMP-069, d5 §6.4, ADR-0257 결정 4). React·브라우저를 모르는 순수 함수만 둔다.
// - 줄의 차례가 곧 순서이고 첫 줄이 포스터다. 임시저장에는 줄 키·대체 텍스트·순서만 넣고 파일은 탭 메모리에만 둔다.
// - 화면 검사(형식은 파일 앞부분, 10MB, 해상도, 장수, 대체 텍스트)는 안내용이고 서버가 다시 본다. 문구는 d5 §6.4의 것이다.

/** 포스터 1장 + 상세 이미지 10장 */
export const IMAGE_MAX = 11;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_ALT_MAX = 300;

/** 임시저장하는 이미지 줄(파일은 넣지 않는다) */
export interface ImageDraft {
  key: string;
  alt: string;
}

export type ImageKind = 'POSTER' | 'DETAIL';

export const IMAGE_TEXT = {
  type: 'JPEG, PNG, WebP 이미지만 올릴 수 있습니다',
  size: '한 장에 10MB까지 올릴 수 있습니다',
  poster: '포스터는 가로 800px, 세로 1,000px 이상인 세로형 이미지여야 합니다',
  detail: '상세 이미지는 가로 800px 이상이어야 합니다',
  pixels: '긴 변 20,000px, 4,000만 화소를 넘는 이미지는 올릴 수 없습니다. 나눠서 올려 주세요',
  animated: '움직이는 이미지는 올릴 수 없습니다',
  count: '포스터 1장과 상세 이미지 10장까지 올릴 수 있습니다',
  unreadable: '이미지를 읽지 못했습니다. 다른 파일로 다시 올려 주세요',
  repick: '이미지는 다시 골라 주세요',
  altMissing: '대체 텍스트를 적어 주세요',
  altLong: '대체 텍스트는 300자까지 적을 수 있습니다',
  unavailable: '이미지를 잠시 확인할 수 없습니다. 잠시 뒤 다시 올려 주세요',
  failed: '이미지를 올리지 못했습니다. 다시 올려 주세요',
} as const;

export const imageKind = (index: number): ImageKind => (index === 0 ? 'POSTER' : 'DETAIL');

type Format = 'jpeg' | 'png' | 'webp';
const BY_TYPE: Record<string, Format> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const BY_EXT: Record<string, Format> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };

function sniff(head: Uint8Array): Format | undefined {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return undefined;
}

const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** 움직이는 PNG(acTL 덩어리)·WebP(VP8X 움직임 표시나 ANIM 덩어리)인가. 앞부분만 본다 */
function animated(head: Uint8Array, f: Format): boolean {
  if (f === 'png') {
    // 덩어리를 차례로 건넌다: 길이(4) 종류(4) 내용 CRC(4). IDAT 앞에 acTL이 있으면 움직이는 PNG다
    for (let i = 8; i + 8 <= head.length; ) {
      const len = ((head[i]! << 24) | (head[i + 1]! << 16) | (head[i + 2]! << 8) | head[i + 3]!) >>> 0;
      const type = ascii(head, i + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT') return false;
      i += 12 + len;
    }
    return false;
  }
  if (f === 'webp') {
    if (ascii(head, 12, 4) === 'VP8X' && head.length > 20 && (head[20]! & 0x02) !== 0) return true;
    for (let i = 12; i + 8 <= head.length; ) {
      if (ascii(head, i, 4) === 'ANIM') return true;
      const len = (head[i + 4]! | (head[i + 5]! << 8) | (head[i + 6]! << 16) | (head[i + 7]! << 24)) >>> 0;
      i += 8 + len + (len % 2);
    }
  }
  return false;
}

/** 파일 앞부분(처음 64KB 정도)·Content-Type·이름·크기로 본 문제. 형식은 앞부분·Content-Type·확장자가 모두 같아야 한다 */
export function fileIssue(o: { head: Uint8Array; type: string; name: string; size: number }): string | null {
  const f = sniff(o.head);
  const dot = o.name.lastIndexOf('.');
  const ext = dot >= 0 ? BY_EXT[o.name.slice(dot + 1).toLowerCase()] : undefined;
  if (f === undefined || f !== BY_TYPE[o.type.toLowerCase()] || f !== ext) return IMAGE_TEXT.type;
  if (o.size > IMAGE_MAX_BYTES) return IMAGE_TEXT.size;
  return animated(o.head, f) ? IMAGE_TEXT.animated : null;
}

/**
 * 파일 앞부분에 적힌 크기(PNG IHDR, WebP VP8X·VP8·VP8L, JPEG SOF). 모르면 undefined.
 * 화소 상한을 넘는 파일을 브라우저가 디코딩하다 멈추지 않게 디코딩 전에 본다
 */
export function headerSize(head: Uint8Array): { width: number; height: number } | undefined {
  const f = sniff(head);
  const u32 = (i: number) => ((head[i]! << 24) | (head[i + 1]! << 16) | (head[i + 2]! << 8) | head[i + 3]!) >>> 0;
  const u24le = (i: number) => head[i]! | (head[i + 1]! << 8) | (head[i + 2]! << 16);
  if (f === 'png' && head.length >= 24 && ascii(head, 12, 4) === 'IHDR') return { width: u32(16), height: u32(20) };
  if (f === 'webp' && head.length >= 30) {
    const kind = ascii(head, 12, 4);
    if (kind === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (kind === 'VP8 ' && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) return { width: (head[26]! | (head[27]! << 8)) & 0x3fff, height: (head[28]! | (head[29]! << 8)) & 0x3fff };
    if (kind === 'VP8L' && head[20] === 0x2f) {
      const b = (i: number) => head[21 + i]!;
      return { width: 1 + (((b(1) & 0x3f) << 8) | b(0)), height: 1 + (((b(3) & 0x0f) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)) };
    }
    return undefined;
  }
  if (f === 'jpeg') {
    // 표시(FF xx)를 차례로 건너며 SOF0~SOF15(DHT C4·JPG C8·DAC CC 제외)를 찾는다
    for (let i = 2; i + 9 < head.length; ) {
      if (head[i] !== 0xff) return undefined;
      const m = head[i + 1]!;
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      const len = (head[i + 2]! << 8) | head[i + 3]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: (head[i + 7]! << 8) | head[i + 8]!, height: (head[i + 5]! << 8) | head[i + 6]! };
      if (m === 0xda) return undefined;
      i += 2 + len;
    }
  }
  return undefined;
}

/** 브라우저가 디코딩한 크기로 본 문제(포스터는 첫 줄) */
export function sizeIssue(kind: ImageKind, width: number, height: number): string | null {
  if (width < 1 || height < 1) return IMAGE_TEXT.unreadable;
  if (Math.max(width, height) > 20_000 || width * height > 40_000_000) return IMAGE_TEXT.pixels;
  if (kind === 'POSTER') return width >= 800 && height >= 1_000 && height > width ? null : IMAGE_TEXT.poster;
  return width >= 800 ? null : IMAGE_TEXT.detail;
}

export function altIssue(alt: string): string | null {
  const n = [...alt.trim()].length;
  if (n === 0) return IMAGE_TEXT.altMissing;
  return n > IMAGE_ALT_MAX ? IMAGE_TEXT.altLong : null;
}

/** 한 줄 옮기기(위로·아래로). 끝이면 그대로 */
export function moveImage(list: readonly ImageDraft[], key: string, dir: 'up' | 'down'): ImageDraft[] {
  const i = list.findIndex((x) => x.key === key);
  const to = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(i, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * 여러 장을 한꺼번에 고르면 끝에 새 줄로 붙인다(11장까지). 복원한 빈 줄은 채우지 않는다: 어느 대체 텍스트가 어느 그림인지는
 * 그 줄의 [파일 고르기]로 사람이 정한다(BAT-145 리뷰). 돌려준 assigned는 고른 파일 차례마다 놓인 줄 키이고, 자리가 없어 놓지 못한 파일 수가 overflow다
 */
export function placePicked(list: readonly ImageDraft[], picked: number, makeKey: () => string): { list: ImageDraft[]; assigned: string[]; overflow: number } {
  const next = [...list];
  const assigned: string[] = [];
  for (let i = 0; i < picked && next.length < IMAGE_MAX; i++) {
    const key = makeKey();
    next.push({ key, alt: '' });
    assigned.push(key);
  }
  return { list: next, assigned, overflow: picked - assigned.length };
}

/** 줄마다의 파일 상태 */
export interface ImageFileState {
  /** 파일이 없으면(복원한 줄) false */
  hasFile: boolean;
  /** 화면 검사 결과. 아직 보는 중이면 undefined */
  issue?: string | null;
}

/** 다음 단계·등록 전에 막을 이미지 오류(줄 키 → 문구). 파일 없는 줄·검사에 걸린 줄·대체 텍스트·장수 */
export function imageErrors(list: readonly ImageDraft[], files: (key: string) => ImageFileState): { key: string | null; message: string }[] {
  const out: { key: string | null; message: string }[] = [];
  if (list.length > IMAGE_MAX) out.push({ key: null, message: IMAGE_TEXT.count });
  for (const x of list) {
    const f = files(x.key);
    const issue = !f.hasFile ? IMAGE_TEXT.repick : (f.issue ?? altIssue(x.alt));
    if (issue) out.push({ key: x.key, message: issue });
  }
  return out;
}

/** 등록 뒤 올리기 차례: 포스터(첫 줄)부터 한 장씩. 상세 이미지의 order는 올릴 때 이미 올린 장수로 정한다(image-upload.ts) */
export function uploadPlan(list: readonly ImageDraft[]): { key: string; kind: ImageKind; alt: string }[] {
  return list.map((x, i) => ({ key: x.key, kind: i === 0 ? ('POSTER' as const) : ('DETAIL' as const), alt: x.alt.trim() }));
}

/** [다시 올리기]를 지금 누를 수 있는가(오류 줄이고, 서버가 준 하한이 지났다) */
export function canRetry(r: { status: string; retryAt?: number }, now: number): boolean {
  return r.status === 'error' && (r.retryAt === undefined || now >= r.retryAt);
}

/** 올리기 실패 응답 → 그 줄의 문구(서버의 title·detail 원문은 보이지 않는다) */
export function uploadProblemText(p: { status: number; type: string; extensions: Record<string, unknown> }): string {
  switch (p.type) {
    case 'image-type-unsupported':
      return IMAGE_TEXT.type;
    case 'image-too-large':
      return IMAGE_TEXT.size;
    case 'image-limit-exceeded':
      return IMAGE_TEXT.count;
    case 'image-spec-invalid': {
      const reason = p.extensions.reason;
      if (reason === 'POSTER_SPEC') return IMAGE_TEXT.poster;
      if (reason === 'DETAIL_SPEC') return IMAGE_TEXT.detail;
      if (reason === 'PIXEL_LIMIT') return IMAGE_TEXT.pixels;
      if (reason === 'ALT_INVALID') return IMAGE_TEXT.altMissing;
      return IMAGE_TEXT.unreadable;
    }
    case 'image-processing-unavailable':
      return IMAGE_TEXT.unavailable;
    default:
      // 연결 끊김·칸막이(429)·서버 오류·남은 시간 부족(504)은 잠시 뒤 다시 올릴 수 있는 실패다
      return p.status === 0 || p.status === 429 || p.status >= 500 ? IMAGE_TEXT.unavailable : IMAGE_TEXT.failed;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 임시저장의 images 칸 모양(없으면 이미지 칸이 생기기 전의 임시저장이다) */
export function isImageList(v: unknown): v is ImageDraft[] | undefined {
  if (v === undefined) return true;
  return Array.isArray(v) && v.length <= IMAGE_MAX && v.every((x) => isRecord(x) && typeof x.key === 'string' && typeof x.alt === 'string' && Object.keys(x).length === 2);
}

/**
 * 올리기 코드 덩어리(image-upload.ts)를 늦게 싣고 올린다. 덩어리를 받지 못하면 올릴 줄을 모두 오류(다시 올리기 가능)로 알린다
 * ('올리는 중'에 멈추지 않게, BAT-145 리뷰)
 */
export async function runUploads(o: {
  load: () => Promise<typeof import('./image-upload.ts')>;
  productionId: string;
  images: readonly ImageDraft[];
  fileOf: (key: string) => File | undefined;
  send: import('./image-upload.ts').SendImage;
  only?: readonly string[];
  done?: readonly string[];
  onEach?: (r: import('./image-upload.ts').UploadOutcome) => void;
}): Promise<import('./image-upload.ts').UploadOutcome[]> {
  const { load, ...rest } = o;
  let mod: typeof import('./image-upload.ts');
  try {
    mod = await load();
  } catch {
    const failed = uploadPlan(o.images)
      .filter((x) => !o.only || o.only.includes(x.key))
      .map((x) => ({ key: x.key, kind: x.kind, status: 'error' as const, message: IMAGE_TEXT.unavailable }));
    for (const r of failed) o.onEach?.(r);
    return failed;
  }
  return mod.uploadImages(rest);
}
