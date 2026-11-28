// 로컬·CI 감사 sink(IR027-01). S3 Object Lock 어댑터는 미실행이라, 이 sink가 같은 JSON 모양을 파일로 남긴다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunbookAuditIntent, RunbookAuditResult, RunbookAuditSink } from '../domain/ports.js';

export class FileRunbookAuditSink implements RunbookAuditSink {
  constructor(private readonly dir: string) {}
  async writeIntent(i: RunbookAuditIntent): Promise<void> {
    const at = join(this.dir, i.commandId);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'intent.json'), `${JSON.stringify(i, null, 2)}\n`, 'utf8');
  }
  async writeResult(r: RunbookAuditResult): Promise<void> {
    const at = join(this.dir, r.commandId);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'result.json'), `${JSON.stringify(r, null, 2)}\n`, 'utf8');
  }
  async readResult(commandId: string): Promise<RunbookAuditResult | null> {
    try {
      return JSON.parse(readFileSync(join(this.dir, commandId, 'result.json'), 'utf8')) as RunbookAuditResult;
    } catch {
      return null;
    }
  }
}
