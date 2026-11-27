// F-04-19 연구 내보내기 포트. 저장소·실버·감사·이용 내역은 이 모양만 안다.
import type {
  PseudonymizationLogRow,
  ResearchColumn,
  ResearchExportRecord,
} from '../domain/research-export.js';

export interface ResearchExportStore {
  put(r: ResearchExportRecord): Promise<void>;
  get(exportId: string): Promise<ResearchExportRecord | null>;
  update(r: ResearchExportRecord): Promise<void>;
  /** 감사·이용 내역이 실패해 만들기를 되돌릴 때 쓴다. */
  delete(exportId: string): Promise<void>;
  listPending(nowMs: number, limit: number): Promise<ResearchExportRecord[]>;
  /** 만료된 레코드·거절 메타데이터를 지운다(배경 스윕, IR0419-01). 없는 저장소는 건너뛴다. */
  deleteExpired?(nowMs: number): Promise<number>;
  countCreatedBetween(i: { accountId: string; fromMs: number; toMs: number }): Promise<number>;
  recordDenial(i: { accountId: string; atMs: number; problemType: string }): Promise<void>;
  countDeniedSince(i: { accountId: string; sinceMs: number }): Promise<number>;
}

export interface ResearchExportBuffer {
  put(exportId: string, bytes: Uint8Array, expiresAtMs: number): Promise<void>;
  get(exportId: string, nowMs: number): Promise<Uint8Array | null>;
}

export interface ResearchSilverSource {
  /** an_forensic_reader 전용. 실버 7표만 읽고 IPC 파일 바이트를 돌려준다. */
  build(i: { eventId: string; fromMs: number; toMs: number }): Promise<{
    bytes: Uint8Array;
    rowCount: number;
    columns: readonly ResearchColumn[];
  }>;
}

export interface ResearchAuditSink {
  append(r: { recordType: string; recordId: string; payload: Record<string, unknown>; nowMs: number }): Promise<void>;
}

export interface PseudonymizationLog {
  append(row: PseudonymizationLogRow): Promise<void>;
}

export interface ResearchExportConfig {
  allowlistVersion: string;
  approvedReviewVersions: readonly string[];
  keyVersion: string;
}

export interface ResearchAlerts {
  raise(i: { kind: 'RESEARCH_EXPORT_DENIALS'; accountId: string; count: number; atMs: number; severity: 'SEV2' | 'SEV3' }): Promise<void>;
}

export interface ResearchDesignations {
  designations(adminAccountId: string): Promise<readonly string[]>;
}

export interface ResearchSchedule {
  get(eventId: string): Promise<{ opensAtMs: number; saleEndsAtMs: number } | undefined>;
}
