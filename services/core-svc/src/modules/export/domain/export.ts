// 예매자 명단 내려받기·다운로드 이력(BUILD_ORDER BAT-610 잔여, FR-027·064, POL-020·023, I-T53, J-T26).
// 파일은 서버에 남기지 않는다(한 번 돌려주고 끝). 이력 행은 감사용으로 남는다.
import type { AttendeeRecord } from '../../shop/index.js';

export type ExportFormat = 'CSV' | 'XLSX' | 'PDF';
export type ExportResult = 'COMPLETED' | 'FAILED';

export class ExportProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'ExportProblem';
  }
}

export interface AttendeeExportRecord {
  exportId: string;
  promoterId: string;
  eventId: string;
  actorAccountId: string;
  actorDisplayName: string;
  actorRole: string;
  reason: string;
  format: ExportFormat;
  count: number;
  result: ExportResult;
  createdAt: Date;
  /** 파일은 남기지 않으므로 이 값은 이력 보존·표시용이다(30일 [가정]). */
  expiresAt: Date;
}

export interface AttendeeExportView {
  exportId: string;
  exportedAt: string;
  actorDisplayName: string;
  actorRole: string;
  reason: string;
  count: number;
  format: ExportFormat;
  result: ExportResult;
}

export const exportView = (r: AttendeeExportRecord): AttendeeExportView => ({
  exportId: r.exportId,
  exportedAt: r.createdAt.toISOString(),
  actorDisplayName: r.actorDisplayName,
  actorRole: r.actorRole,
  reason: r.reason,
  count: r.count,
  format: r.format,
  result: r.result,
});

export function validateExportBody(body: { reason?: unknown; format?: unknown }): { reason: string; format: ExportFormat } {
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) throw new ExportProblem('invalid-query', 422, '다운로드 사유가 필요합니다');
  if (body.reason.length > 500) throw new ExportProblem('invalid-query', 422, '다운로드 사유는 500자까지입니다');
  const format = body.format ?? 'CSV';
  if (format !== 'CSV' && format !== 'XLSX' && format !== 'PDF') throw new ExportProblem('invalid-query', 422, '파일 형식이 맞지 않습니다');
  return { reason: body.reason.trim(), format };
}

/** 회차 종료 1개월 뒤 닫는다(연기 회차는 바뀐 회차 기준, POL-023). */
export const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

export function retentionEnded(eventEndsAt: Date, now: Date): boolean {
  return now.getTime() > eventEndsAt.getTime() + RETENTION_MS;
}

/**
 * 접속기록 보존 끝: UTC 달력으로 2년 뒤 같은 월·일·시각(2월 29일 → 3월 1일). 730일이 아니다(W7-audit A2-19, docs/data.md §2).
 * Date.UTC는 없는 날(2년 뒤 2월 29일)을 다음 달 1일로 넘긴다.
 */
export function accessLogRetainUntil(createdAt: Date): Date {
  return new Date(
    Date.UTC(
      createdAt.getUTCFullYear() + 2,
      createdAt.getUTCMonth(),
      createdAt.getUTCDate(),
      createdAt.getUTCHours(),
      createdAt.getUTCMinutes(),
      createdAt.getUTCSeconds(),
      createdAt.getUTCMilliseconds(),
    ),
  );
}

/** 내려받는 동안 서버가 들고 있는 행 수를 제한한다(J-T26 ② 스트리밍, 50만 행 [가정] 상한). */
export const MAX_EXPORT_ROWS = 500_000;

export interface ExportFile {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

const safeCell = (value: string): string => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

export function csvFile(rows: readonly AttendeeRecord[], eventLabel: string): ExportFile {
  const header = ['예매자', '휴대폰', '예매번호', '좌석', '매수'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push([r.buyerName, r.buyerPhone, r.orderId, r.seatLabel ?? '', String(r.quantity)].map((v) => `"${safeCell(v).replaceAll('"', '""')}"`).join(','));
  const body = new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}\r\n`);
  return { body, contentType: 'text/csv; charset=utf-8', filename: `${eventLabel}_예매자명단.csv` };
}

// ---- 최소 XLSX(압축 없는 ZIP, inlineStr) ----
// 외부 라이브러리를 더하지 않으려고 xlsx 한 장짜리 묶음을 직접 만든다. 수식 주입은 CSV와 같은 규칙으로 막는다.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length + e.data.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, e.data.length, true);
    dv.setUint32(22, e.data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(e.data, 30 + name.length);
    chunks.push(local);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = chunks.reduce((s, c) => s + c.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const xmlEscape = (v: string): string => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function columnName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function xlsxFile(rows: readonly AttendeeRecord[], eventLabel: string): ExportFile {
  const header = ['예매자', '휴대폰', '예매번호', '좌석', '매수'];
  const all = [header, ...rows.map((r) => [r.buyerName, r.buyerPhone, r.orderId, r.seatLabel ?? '', String(r.quantity)])];
  const sheetRows = all
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"><is><t>${xmlEscape(safeCell(v))}</t></is></c>`).join('')}</row>`)
    .join('');
  const files: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="예매자 명단" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: new TextEncoder().encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: new TextEncoder().encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    },
  ];
  return {
    body: zipStore(files),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${eventLabel}_예매자명단.xlsx`,
  };
}
