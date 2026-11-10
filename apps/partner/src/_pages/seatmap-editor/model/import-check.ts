// 가져오기 대화상자의 앞 검사와 결과 읽기(ADR-0264 결정 9, ADR-0257 결정 8, d5 §6.5 '가져오기 결과'). 순수 함수만 둔다.
// 10MB [가정]를 넘거나 앞부분이 압축 파일(gzip·zip)이면 보내지 않고 서버와 같은 문구를 보인다(문구는 오류 갈래로 고른다).
// 파일 칸 이름은 seatmap.{svg|json|csv}로 바꿔 보낸다(사용자 파일 이름을 보내지 않는다, seat-hold ASVS 5.4.1).
// 오류는 표(줄·칸·쉬운 문구, 서버가 준 1,000개까지)로 보이고 반영하지 않는다. SVG_IGNORED는 이름만 글자로 보인다.
import { issueText } from './issues.ts';
import type { Issue } from './types.ts';

/** 한 파일의 상한(바이트, 서버 SEATMAP_FILE_MAX_BYTES와 같은 10MB [가정]) */
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
/** 오류 표에 싣는 상한(서버 SEATMAP_MAX_ISSUES) */
export const ISSUES_SHOWN_MAX = 1_000;

export type ImportFormat = 'SVG' | 'JSON' | 'CSV';

/** 413 seatmap-import-too-large와 같은 문구(화면 검사와 서버 답이 같은 글을 보인다) */
export const TOO_LARGE_TEXT = '좌석맵 파일은 10MB까지 올릴 수 있습니다. 압축 파일은 받지 않습니다';

/** 압축 파일의 앞부분(gzip 1F 8B, zip 50 4B 03 04). 서버 isCompressed와 같다 */
export function isCompressed(head: Uint8Array): boolean {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return true;
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** 보내기 전 검사. 보내도 되면 null */
export function precheck(size: number, head: Uint8Array): string | null {
  if (size > IMPORT_MAX_BYTES || isCompressed(head)) return TOO_LARGE_TEXT;
  if (size === 0) return '빈 파일입니다';
  return null;
}

/** multipart 파일 칸의 이름 */
export const importFileName = (f: ImportFormat) => `seatmap.${f.toLowerCase()}`;

/** 파일 칸의 형식(서버는 형식만 믿고 이름·확장자는 보지 않는다) */
export const IMPORT_MIME: Record<ImportFormat, string> = { SVG: 'image/svg+xml', JSON: 'application/json', CSV: 'text/csv' };

export interface ImportRow {
  line: number;
  field: string;
  text: string;
}

export interface ImportView {
  ok: boolean;
  rows: ImportRow[];
  /** 서버가 준 오류 수(표는 1,000개까지) */
  errorCount: number;
  /** '읽지 않고 넘긴 요소: script, image'(SVG_IGNORED) */
  ignoredText: string | null;
  layout: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 가져오기 200 결과(SeatMapImportResult) → 대화상자 */
export function importView(result: unknown): ImportView {
  const r = isObj(result) ? result : {};
  const errors = (Array.isArray(r.errors) ? r.errors : []).filter(isObj) as unknown as Issue[];
  const ignored = (Array.isArray(r.warnings) ? r.warnings : []).filter(isObj).filter((w) => w.code === 'SVG_IGNORED').flatMap((w) => (Array.isArray(w.ignored) ? w.ignored.map(String) : []));
  return {
    ok: r.ok === true && errors.length === 0,
    rows: errors.slice(0, ISSUES_SHOWN_MAX).map((e) => ({ line: Number(e.line) || 0, field: String(e.field ?? ''), text: issueText(String(e.code ?? '')) })),
    errorCount: errors.length,
    ignoredText: ignored.length > 0 ? `읽지 않고 넘긴 요소: ${[...new Set(ignored)].join(', ')}` : null,
    layout: r.layout,
  };
}

/** 가져오기 오류 답 → 문구 */
export function importFailureText(status: number, type: string): string {
  if (status === 413 || type === 'seatmap-import-too-large') return TOO_LARGE_TEXT;
  if (status === 422 || type === 'seatmap-import-rejected') return '좌석맵 파일을 읽지 않았습니다. 형식과 내용이 맞는지, 좌석 5만·구역 500개를 넘지 않는지 확인해 주세요';
  if (status === 429) return '지금 올리는 파일이 많습니다. 잠시 뒤 다시 올려 주세요';
  if (status === 503) return '좌석맵 파일을 잠시 확인할 수 없습니다. 잠시 뒤 파일을 다시 올려 주세요';
  if (status === 404) return '공연을 찾을 수 없습니다';
  if (status === 403) return '이 공연의 좌석맵을 가져올 권한이 없습니다';
  return '파일을 올리지 못했습니다. 다시 올려 주세요';
}
