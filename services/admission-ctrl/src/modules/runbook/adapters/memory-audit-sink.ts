// 시험·미리보기용 메모리 감사 sink(IR027-01). 실제 Job은 파일이나 S3 sink를 쓴다.
import type { RunbookAuditIntent, RunbookAuditResult, RunbookAuditSink } from '../domain/ports.js';

export class MemoryRunbookAuditSink implements RunbookAuditSink {
  readonly intents: RunbookAuditIntent[] = [];
  readonly results: RunbookAuditResult[] = [];
  async writeIntent(i: RunbookAuditIntent): Promise<void> {
    this.intents.push(i);
  }
  async writeResult(r: RunbookAuditResult): Promise<void> {
    this.results.push(r);
  }
  async readResult(commandId: string): Promise<RunbookAuditResult | null> {
    return this.results.find((r) => r.commandId === commandId) ?? null;
  }
}
