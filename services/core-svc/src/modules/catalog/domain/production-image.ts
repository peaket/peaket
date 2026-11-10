// 도메인 층: 공연 이미지(포스터 1장·상세 0~10장)의 규칙(ADR-0062 결정 38, ADR-0257 결정 1~3, docs/data.md production_image, BUILD_ORDER HOT-190).
// 디코딩·다시 인코딩은 image-worker가 하고(core-svc는 원본을 디코딩하지 않는다), 여기서는 파일 앞부분·종류별 기준·파생본 키·순서만 판정한다.
// 순수 함수만 둔다. 수치는 [가정]이다.

/** 한 장의 상한(바이트, 10MB) */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** multipart 봉투(칸 이름·경계·대체 텍스트) 여유 [가정]. 서버의 본문 상한은 10MB + 이 값이다 */
export const IMAGE_ENVELOPE_BYTES = 64 * 1024;
export const DETAIL_MAX = 10;
export const ALT_MAX = 300;
export const POSTER_MIN_WIDTH = 800;
export const POSTER_MIN_HEIGHT = 1_000;
export const DETAIL_MIN_WIDTH = 800;
export const LONG_SIDE_MAX = 20_000;
export const PIXELS_MAX = 40_000_000;
/** 파트너 multipart 받기 칸막이: 파드마다 동시 4 [가정], 차면 429 Retry-After 10초 [가정](ADR-0257 결정 2, docs/verification.md §4.1) */
export const PARTNER_MULTIPART_BULKHEAD = { name: 'partner-multipart', limit: 4, retryAfterSeconds: 10 } as const;
/** 올리기 경로의 남은 시간 [가정](본문 받는 시간까지 넣는다) */
export const UPLOAD_ROUTE_DEADLINE_MS = 90_000;
/** 처리 데드라인 상한·여유·최소 [가정]: min(30초, 남은 시간 − 2초)이고 10초보다 작으면 맡기지 않는다(504) */
export const PROCESSING_DEADLINE_MS = 30_000;
export const PROCESSING_MARGIN_MS = 2_000;
export const PROCESSING_MIN_MS = 10_000;
/** 준비 위치 파생본 하나의 상한 [가정](크기를 먼저 보고 넘으면 읽지 않는다) */
export const DERIVATIVE_MAX_BYTES = 5 * 1024 * 1024;

/** 처리를 맡길 데드라인(ms). 남은 시간이 모자라 맡기지 않을 때는 undefined */
export function processingBudget(remainingMs: number): number | undefined {
  const budget = Math.min(PROCESSING_DEADLINE_MS, remainingMs - PROCESSING_MARGIN_MS);
  return budget >= PROCESSING_MIN_MS ? budget : undefined;
}

/** 파생본의 파일 앞부분이 이름의 형식과 맞는가(WebP RIFF????WEBP, AVIF ftyp 상자의 상표 avif·avis) */
export function derivativeFormatOk(name: string, head: Uint8Array): boolean {
  const ascii = (i: number, n: number) => String.fromCharCode(...head.subarray(i, i + n));
  if (name.endsWith('.webp')) return head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (!name.endsWith('.avif') || head.length < 12 || ascii(4, 4) !== 'ftyp') return false;
  const boxSize = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  const end = Math.min(head.length, boxSize >= 16 ? boxSize : 12);
  // 주 상표(8~11)와 호환 상표(16부터 4바이트씩)
  const brands = [ascii(8, 4)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(i, 4));
  return brands.some((b) => b === 'avif' || b === 'avis');
}
export const DERIVATIVE_WIDTHS = [320, 640, 960, 1280] as const;
export const DERIVATIVE_FORMATS = ['avif', 'webp'] as const;

export type ImageKind = 'POSTER' | 'DETAIL';
export type ImageFormat = 'jpeg' | 'png' | 'webp';
/** 422 image-spec-invalid의 reason */
export type SpecReason = 'PIXEL_LIMIT' | 'POSTER_SPEC' | 'DETAIL_SPEC' | 'MALWARE' | 'ALT_INVALID';

export interface ProductionImageRow {
  id: string;
  productionId: string;
  promoterId: string;
  kind: ImageKind;
  alt: string;
  order: number;
  width: number;
  height: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 파일 앞부분(매직 바이트)이 가리키는 형식. JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, WebP RIFF????WEBP */
export function sniffFormat(head: Uint8Array): ImageFormat | undefined {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (head.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (head.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (head.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return undefined;
}

const BY_TYPE: Record<string, ImageFormat> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const BY_EXT: Record<string, ImageFormat> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };

/**
 * 파일 칸의 Content-Type·확장자·파일 앞부분이 모두 같은 형식이면 그 형식(ADR-0257 결정 2). 하나라도 다르면 undefined(415).
 * 파일 이름은 확장자를 보는 데만 쓰고 버린다(catalog-review 5.3.2)
 */
export function agreedFormat(head: Uint8Array, contentType: string, fileName: string): ImageFormat | undefined {
  const sniffed = sniffFormat(head);
  const byType = BY_TYPE[contentType.split(';')[0]!.trim().toLowerCase()];
  const dot = fileName.lastIndexOf('.');
  const byExt = dot >= 0 ? BY_EXT[fileName.slice(dot + 1).toLowerCase()] : undefined;
  return sniffed !== undefined && sniffed === byType && sniffed === byExt ? sniffed : undefined;
}

/** 대체 텍스트: 1~300자(코드 포인트), 저장할 수 없는 글자(NUL, 짝이 깨진 서로게이트)가 없다 */
export function altValid(alt: string): boolean {
  if (/\p{Cs}/u.test(alt) || alt.includes('\u0000')) return false;
  const n = [...alt].length;
  return n >= 1 && n <= ALT_MAX;
}

/**
 * image-worker가 돌려준 폭·높이를 다시 본다(catalog-review 5.4.3 '돌아온 결과를 그대로 믿지 않는다').
 * 공통: 1 이상, 긴 변 20,000px·4,000만 화소 이하. 포스터: 가로 800·세로 1,000px 이상이고 세로가 가로보다 길다. 상세: 가로 800px 이상
 */
export function specViolation(kind: ImageKind, width: number, height: number): SpecReason | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return 'PIXEL_LIMIT';
  if (Math.max(width, height) > LONG_SIDE_MAX || width * height > PIXELS_MAX) return 'PIXEL_LIMIT';
  if (kind === 'POSTER') return width >= POSTER_MIN_WIDTH && height >= POSTER_MIN_HEIGHT && height > width ? undefined : 'POSTER_SPEC';
  return width >= DETAIL_MIN_WIDTH ? undefined : 'DETAIL_SPEC';
}

/** 격리 원본 키. 서버가 만든 이미지 ID로만 만든다(사용자 파일 이름은 쓰지 않는다) */
export const quarantineKey = (imageId: string) => `quarantine/production/${imageId}`;
/** 파생본 이름 여덟 개('{폭}.{형식}') */
export const derivativeNames = (): string[] => DERIVATIVE_WIDTHS.flatMap((w) => DERIVATIVE_FORMATS.map((f) => `${w}.${f}`));
export const stagingKey = (imageId: string, name: string) => `staging/production/${imageId}/${name}`;
export const publicKey = (imageId: string, name: string) => `production/${imageId}/${name}`;

/** 돌아온 파생본 키가 정확히 그 이미지의 준비 위치 여덟 개인가(모자람·남음·겹침·접두사 밖은 아니다) */
export function derivativeKeysMatch(imageId: string, keys: readonly string[]): boolean {
  const want = derivativeNames().map((n) => stagingKey(imageId, n));
  return keys.length === want.length && new Set(keys).size === keys.length && want.every((k) => keys.includes(k));
}

/** 파생본 묶음의 기준 주소({이미지 출처}/production/{imageId}, ADR-0199 결정 4) */
export const imageBaseUrl = (origin: string, imageId: string) => `${origin.replace(/\/+$/, '')}/production/${imageId}`;

/** 계약 ProductionImage.derivatives: '{폭}.{형식}' → 주소 */
export function derivativeUrls(origin: string, imageId: string): Record<string, string> {
  const base = imageBaseUrl(origin, imageId);
  return Object.fromEntries(derivativeNames().map((n) => [n, `${base}/${n}`]));
}

/**
 * 상세 이미지 순서를 다시 매긴다: 옮길 이미지를 빼고 to 자리(0부터, 넘으면 끝)에 넣은 뒤 0부터 빈틈 없이 매긴다.
 * movingId가 없으면(지운 뒤) 남은 것만 다시 매긴다. 돌려준 목록은 새 순서다
 */
export function reorderDetails(details: readonly { id: string; order: number }[], movingId?: string, to?: number): { id: string; order: number }[] {
  const sorted = [...details].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const rest = sorted.filter((d) => d.id !== movingId);
  const moving = sorted.find((d) => d.id === movingId);
  if (moving && to !== undefined) rest.splice(Math.max(0, Math.min(to, rest.length)), 0, moving);
  return rest.map((d, i) => ({ id: d.id, order: i }));
}
