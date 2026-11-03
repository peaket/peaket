// 결과 파일(docs/verification.md §2.5, docs/perf-ledger.md 실행 폴더).
// - invariants.csv: 공개 저장소에 두므로 건수만 쓴다(ASVS v5.0.0-14.2.4)
// - invariants-detail.ndjson: 위반 행. 불변식마다 1,000줄까지이고 성능 장부 원본 버킷에 둔다(Git에 두지 않는다)
export type Verdict = 'PASS' | 'FAIL' | 'SKIPPED';

export interface Violation {
  subject: string;
  detail: string;
}

export interface InvariantResult {
  id: string;
  name: string;
  sources: string[];
  violations: number;
  /** 결과를 모르는 요청 수(대기열 기록). 위반으로 세지 않지만 숨기지 않는다 */
  unknown: number;
  result: Verdict;
  /** SKIPPED의 까닭 */
  reason?: string;
  details: Violation[];
}

export const DETAIL_LIMIT = 1000;
const KST_OFFSET_MS = 9 * 3_600_000;

export const kstIso = (ms: number) => `${new Date(ms + KST_OFFSET_MS).toISOString().slice(0, -1)}+09:00`;

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(results: readonly InvariantResult[], asOfMs: number): string {
  const asOf = kstIso(asOfMs);
  const rows = results.map((r) => {
    const skipped = r.result === 'SKIPPED';
    return [r.id, r.name, r.sources.join('+'), skipped ? '' : String(r.violations), skipped ? '' : String(r.unknown), r.result, asOf].map(cell).join(',');
  });
  return `${['id,name,sources,violations,unknown,result,as_of', ...rows].join('\n')}\n`;
}

export function toDetailNdjson(results: readonly InvariantResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const d of r.details) lines.push(JSON.stringify({ id: r.id, subject: d.subject, detail: d.detail }));
    if (r.violations > r.details.length) lines.push(JSON.stringify({ id: r.id, truncated: r.violations - r.details.length }));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export const exitCode = (results: readonly InvariantResult[]): 0 | 1 => (results.some((r) => r.result === 'FAIL') ? 1 : 0);
