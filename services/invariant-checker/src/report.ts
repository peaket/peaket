// 결과 파일(docs/verification.md §2.5, docs/perf-ledger.md 실행 폴더).
// - invariants.csv: 공개 저장소에 두므로 건수만 쓴다(ASVS v5.0.0-14.2.4)
// - invariants-detail.ndjson: 위반 행. 불변식마다 1,000줄까지이고 성능 장부 원본 버킷에 둔다(Git에 두지 않는다)
// - 요약 한 줄·건너뜀 경고: SKIPPED가 조용히 묻히지 않게 한다(§2.5 '건너뜀(SKIPPED)을 드러내기'). 종료 코드는 바꾸지 않는다
import { INVARIANTS } from './invariants.js';
import { SOURCE_TABLES } from './tables.js';

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
  /** SKIPPED의 까닭(사람이 읽는 글) */
  reason?: string;
  /**
   * SKIPPED의 까닭 갈래. records: 시험 기록 없음(names는 빈 배열), source: 원본 없음(없는 원본 이름),
   * table: 붙은 원본에 표 없음(없는 표 이름). table만 경고한다(기능이 아직 없거나 표 이름이 정본과 다르다)
   */
  skip?: { kind: 'records' | 'source' | 'table'; names: string[] };
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

const ORDER = new Map(INVARIANTS.map((d, i) => [d.id, i] as const));
const byInvariantOrder = (a: InvariantResult, b: InvariantResult) => (ORDER.get(a.id) ?? ORDER.size) - (ORDER.get(b.id) ?? ORDER.size);

/** 결과별 개수와 SKIPPED 불변식·까닭을 모은 요약 한 줄(표준 출력). 차례는 INVARIANTS 차례다 */
export function summaryLine(results: readonly InvariantResult[]): string {
  const count = (v: Verdict) => results.filter((r) => r.result === v).length;
  const skipped = results.filter((r) => r.result === 'SKIPPED').sort(byInvariantOrder);
  const tail = skipped.length ? skipped.map((r) => `${r.id}(${r.reason ?? '까닭 모름'})`).join(', ') : 'SKIPPED 없음';
  return `요약: PASS ${count('PASS')} · FAIL ${count('FAIL')} · SKIPPED ${count('SKIPPED')} — ${tail}`;
}

/** 원본 DB에는 붙었는데 표가 없어 건너뛴 불변식마다 경고 한 줄(표준 오류). 기록·원본이 없어 건너뛴 것은 넣지 않는다 */
export function skipWarnings(results: readonly InvariantResult[]): string[] {
  return results
    .filter((r) => r.result === 'SKIPPED' && r.skip?.kind === 'table')
    .sort(byInvariantOrder)
    .map((r) => {
      const names = r.skip!.names;
      const fromTables = [...new Set(names.map((n) => SOURCE_TABLES.find((t) => t.name === n)?.source).filter((x): x is NonNullable<typeof x> => x !== undefined))];
      const sources = fromTables.length ? fromTables : r.sources.filter((x) => x !== 'records');
      return `경고: ${r.id} 원본(${sources.join('·')})에 붙었는데 표가 없다: ${names.join(', ')} — 기능이 아직 없거나 표 이름이 docs/data.md와 다르다`;
    });
}
