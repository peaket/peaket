// 내보내기 셋(ADR-0264 결정 10, FE-T38 ①②). 에디터 Worker가 부른다. 내보낸 파일을 다시 가져오면 같은 구역·좌석 수가 된다.
// - JSON: SeatMapLayoutInput 모양(색인 없이). 가져오기 JSON이 그대로 받는다.
// - CSV: 가져오기 CSV와 같은 9열 머리(ADR-0257 결정 7). RFC 4180 따옴표, =·+·-·@·탭·CR로 시작하는 칸은 앞에 작은따옴표(docs/api/guidelines.md §9).
//   좌석 한 줄이 한 행이고 구역의 첫 행에만 shape를 적는다. 좌석이 없는 구역은 CSV로 낼 수 없어 뺀다(skippedSections).
// - SVG: 가져오기 SVG 읽개가 읽는 모양(구역 polygon + data-section, 좌석 circle + data-section·data-row·data-number·data-tier·data-wheelchair·data-gate,
//   무대 data-kind="stage"). 속성 값은 XML 엔터티로 바꾼다(구역 이름 '<img …>'도 글자로 남는다).
// 파일 이름은 seatmap-{공연 ID 앞 8자}-v{판}.{json|csv|svg}이고 사용자 글자를 넣지 않는다(seat-hold ASVS 5.4.1).
import { fileStem, saveBody, sectionsInOrder, seatTier } from './doc.ts';
import type { EditorDoc } from './types.ts';

export type ExportFormat = 'JSON' | 'CSV' | 'SVG';

export interface ExportedFile {
  name: string;
  mime: string;
  text: string;
  /** CSV에 싣지 못한 좌석 없는 구역 수 */
  skippedSections: number;
}

export const CSV_HEADER = ['section', 'row', 'number', 'x', 'y', 'tier', 'wheelchair', 'gate', 'shape'] as const;

/** CSV 칸 하나: 수식으로 읽힐 첫 글자는 앞에 작은따옴표, 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다 */
export function csvCell(v: string): string {
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function exportCsv(doc: EditorDoc): { text: string; skippedSections: number } {
  const lines: string[] = [CSV_HEADER.join(',')];
  let skipped = 0;
  for (const s of sectionsInOrder(doc)) {
    if (s.seats.length === 0) {
      skipped++;
      continue;
    }
    const shape = s.shape.points.map(([x, y]) => `${x} ${y}`).join(';');
    s.seats.forEach((x, i) => {
      const cells = [s.name, x.row, String(x.number), String(x.x), String(x.y), seatTier(s, x) ?? '', x.wheelchair ? 'true' : '', x.gateZone ?? s.gateZone ?? '', i === 0 ? shape : ''];
      lines.push(cells.map(csvCell).join(','));
    });
  }
  return { text: `${lines.join('\r\n')}\r\n`, skippedSections: skipped };
}

/** XML 속성 값 */
export const xmlAttr = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** 좌석 원 반지름(그리기만, 가져오기는 중심만 읽는다) */
const SEAT_R = 20;

export function exportSvg(doc: EditorDoc): string {
  const { width, height } = doc.canvas;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`];
  const pts = (p: readonly (readonly [number, number])[]) => p.map(([x, y]) => `${x},${y}`).join(' ');
  for (const st of doc.stage) out.push(`<polygon data-kind="stage"${st.name !== undefined ? ` data-section="${xmlAttr(st.name)}"` : ''} points="${pts(st.points)}"/>`);
  for (const s of sectionsInOrder(doc)) out.push(`<polygon data-section="${xmlAttr(s.name)}" points="${pts(s.shape.points)}"/>`);
  for (const s of sectionsInOrder(doc)) {
    const name = xmlAttr(s.name);
    for (const x of s.seats) {
      const tier = seatTier(s, x);
      const gate = x.gateZone ?? s.gateZone;
      out.push(
        `<circle cx="${x.x}" cy="${x.y}" r="${SEAT_R}" data-section="${name}" data-row="${xmlAttr(x.row)}" data-number="${x.number}"${tier !== undefined ? ` data-tier="${xmlAttr(tier)}"` : ''}${x.wheelchair ? ' data-wheelchair="true"' : ''}${gate !== undefined ? ` data-gate="${xmlAttr(gate)}"` : ''}/>`,
      );
    }
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

export function exportJson(doc: EditorDoc, version: number): string {
  return `${JSON.stringify(saveBody(doc, version), null, 2)}\n`;
}

const MIME: Record<ExportFormat, string> = { JSON: 'application/json', CSV: 'text/csv;charset=utf-8', SVG: 'image/svg+xml' };

export function exportFile(doc: EditorDoc, format: ExportFormat, productionId: string, version: number): ExportedFile {
  const name = `${fileStem(productionId, version)}.${format.toLowerCase()}`;
  if (format === 'CSV') {
    const { text, skippedSections } = exportCsv(doc);
    return { name, mime: MIME.CSV, text, skippedSections };
  }
  return { name, mime: MIME[format], text: format === 'SVG' ? exportSvg(doc) : exportJson(doc, version), skippedSections: 0 };
}
