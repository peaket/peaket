// S3 Object Lock 감사 sink 골격(IR027-01). 실제 버킷·IAM·Object Lock은 구간 5라 미실행이다.
// 이 클래스는 조용히 성공하지 않는다(fail closed): 쓰기를 부르면 미실행 오류로 CLI가 6으로 끝난다.
import type { RunbookAuditIntent, RunbookAuditResult, RunbookAuditSink } from '../domain/ports.js';

export class S3RunbookAuditSink implements RunbookAuditSink {
  constructor(readonly bucket: string) {}
  async writeIntent(_i: RunbookAuditIntent): Promise<void> {
    throw new Error(`S3 Object Lock 감사 sink는 미실행이다(bucket ${this.bucket})`);
  }
  async writeResult(_r: RunbookAuditResult): Promise<void> {
    throw new Error(`S3 Object Lock 감사 sink는 미실행이다(bucket ${this.bucket})`);
  }
  async readResult(_commandId: string): Promise<RunbookAuditResult | null> {
    return null;
  }
}
