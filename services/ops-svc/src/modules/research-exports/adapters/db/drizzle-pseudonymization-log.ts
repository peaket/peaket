// F-04-19 가명정보 처리 기록 Drizzle 판(ops DB, 마이그레이션 0040). 목적 SCIENTIFIC_RESEARCH 줄을 남긴다.
import { randomUUID } from 'node:crypto';
import type { Database } from '@peaket/platform';
import type { PseudonymizationLogRow } from '../../domain/research-export.js';
import type { PseudonymizationLog } from '../../domain/ports.js';
import { pseudonymizationLog } from './schema.js';

export class DrizzlePseudonymizationLog implements PseudonymizationLog {
  constructor(private readonly db: Database) {}

  async append(row: PseudonymizationLogRow): Promise<void> {
    await this.db.db.insert(pseudonymizationLog).values({
      id: randomUUID(),
      eventId: row.eventId,
      purpose: row.purpose,
      items: row.items,
      keyVersion: row.keyVersion,
      usage: row.usage,
      processedFrom: new Date(row.processedFromMs),
      destroyDueAt: new Date(row.destroyDueAtMs),
    });
  }
}
