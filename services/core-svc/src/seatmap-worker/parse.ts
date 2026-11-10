// 좌석맵 가져오기 파일 해석(순수 함수, seatmap-worker의 작업 스레드가 부른다. ADR-0257 결정 5~7, docs/features/seat-hold.md §10).
// 요청의 format과 내용이 맞아야 한다. 파일 이름과 확장자는 받지도 않는다. 결과는 seatmap.proto ParseSeatmapImportResponse의 모양이다.
import type { SeatmapFormat, SeatmapIssue } from '../modules/catalog/domain/seatmap-import.js';
import { readCsv } from './csv.js';
import { readJson } from './json.js';
import { Rejected, type ParsedLayout } from './layout-builder.js';
import { readSvg } from './svg.js';
import { decodeUtf8, NotUtf8 } from './text.js';

export type ParseOutcome =
  | { status: 'PARSED'; layout: ParsedLayout; errors: SeatmapIssue[]; ignored: string[] }
  | { status: 'REJECTED'; errors: SeatmapIssue[]; ignored: string[] };

/** 파일 바이트와 형식 → 해석 결과. 던지지 않는다(예상 밖 오류는 부른 쪽이 INTERNAL로 답한다) */
export function parseSeatmapFile(bytes: Uint8Array, format: SeatmapFormat): ParseOutcome {
  try {
    const text = decodeUtf8(bytes);
    const { layout, builder } = format === 'SVG' ? readSvg(text) : format === 'CSV' ? readCsv(text) : readJson(text);
    return { status: 'PARSED', layout, errors: builder.issues, ignored: builder.ignored };
  } catch (e) {
    if (e instanceof NotUtf8) return { status: 'REJECTED', errors: [{ line: 0, field: 'file', code: 'FORMAT_MISMATCH' }], ignored: [] };
    if (e instanceof Rejected) return { status: 'REJECTED', errors: [{ line: e.line, field: e.field, code: e.code }], ignored: [] };
    throw e;
  }
}

/** 응답의 배치 JSON 상한: 보내기 상한 8MiB [가정]에서 봉투 64KB를 뺀 값(ADR-0257 결정 5) */
export const LAYOUT_JSON_MAX_BYTES = 8 * 1024 * 1024 - 64 * 1024;

export type Reply =
  | { status: 'PARSED'; layoutJson: string; errors: SeatmapIssue[]; ignored: string[]; seats: number; sections: number }
  | { status: 'REJECTED'; errors: SeatmapIssue[]; ignored: string[] };

/** 해석 결과 → 보낼 답. 배치 JSON이 상한을 넘으면 보내지 않고 REJECTED LAYOUT_TOO_LARGE다(보내기 상한에 걸려 늘 503이 되지 않게) */
export function toReply(r: ParseOutcome, maxBytes = LAYOUT_JSON_MAX_BYTES): Reply {
  if (r.status === 'REJECTED') return r;
  const layoutJson = JSON.stringify(r.layout);
  if (Buffer.byteLength(layoutJson, 'utf8') > maxBytes) return { status: 'REJECTED', errors: [{ line: 0, field: 'layout', code: 'LAYOUT_TOO_LARGE' }], ignored: [] };
  return { status: 'PARSED', layoutJson, errors: r.errors, ignored: r.ignored, seats: r.layout.sections.reduce((n, s) => n + s.seats.length, 0), sections: r.layout.sections.length };
}
